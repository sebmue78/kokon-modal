#include <metal_stdlib>
using namespace metal;

// Text generation (Prompt+, QwenTextGeneration.swift): one token at a time, so every product is a matrix-vector
// product that reads the whole weight once. They read the GGUF's Q4_K, Q6_K and Q8_0 blocks where they lie (the mapped
// file), with ggml's formulas (dequant.metal), and add in fp32: the decode is bound by those bytes.

struct MatvecParams {
    uint rows;           // the weight's ggml rows (output features)
    uint blocksPerRow;   // 256-value blocks along the input
    uint rowBytes;
};

// y[r] = W[r, :] · x. Two rows per SIMD group, 4 SIMD groups a threadgroup. 8 lanes share a block, each taking 32 of
// its values (Q4_K: one 16-byte load of nibbles, low and high halves from two sub-blocks; Q6_K: 8 bytes of each of
// its three byte runs, 2-byte aligned as its 210-byte blocks are), so the 32 lanes read 4 neighbouring blocks of a row
// at once; the activations a lane needs are loaded once for both rows. M2 Pro, 2026-10-25 (`time-matvec`): one lane
// per 64 values and one row per SIMD group read 25–53 GB/s.
#define MATVEC_ROWS 2
#define MATVEC_Q4_ROWS 4

static inline float4 nibbles(uint v) { return float4(as_type<uchar4>(v & 0x0F0F0F0Fu)); }

kernel void matvec_q4_K(device const uchar *w [[buffer(0)]], device const float *x [[buffer(1)]],
                        device float *y [[buffer(2)]], constant MatvecParams &p [[buffer(3)]],
                        uint group [[threadgroup_position_in_grid]], uint lane [[thread_index_in_simdgroup]],
                        uint simd [[simdgroup_index_in_threadgroup]], uint groups [[simdgroups_per_threadgroup]]) {
    uint row0 = (group * groups + simd) * MATVEC_Q4_ROWS;
    if (row0 >= p.rows) return;
    uint pair = (lane % 8) / 2, part = lane % 2;   // sub-blocks 2·pair (low nibbles) and 2·pair + 1 (high)
    float sums[MATVEC_Q4_ROWS] = {0};
    for (uint b = lane / 8; b < p.blocksPerRow; b += 4) {
        device const float4 *xl = (device const float4 *)(x + b * 256 + 64 * pair + 16 * part);
        float4 a0 = xl[0], a1 = xl[1], a2 = xl[2], a3 = xl[3], c0 = xl[8], c1 = xl[9], c2 = xl[10], c3 = xl[11];
        float sa = dot(a0 + a1 + a2 + a3, float4(1)), sc = dot(c0 + c1 + c2 + c3, float4(1));
        for (uint r = 0; r < MATVEC_Q4_ROWS; r++) {
            if (row0 + r >= p.rows) break;
            device const uchar *block = w + (ulong)(row0 + r) * p.rowBytes + b * 144;
            // d, dmin and the 12 bytes of 6-bit scales and mins in one load; get_scale_min_k4 for all 8 sub-blocks at
            // once (bytes 0–3 of each word: sub-blocks 0–3, then 4–7), of which this lane takes 2·pair and 2·pair + 1.
            uint4 head = *((device const uint4 *)block);
            half2 dd = as_type<half2>(head.x);
            uint scales = pair < 2 ? head.y & 0x3F3F3F3Fu : (head.w & 0x0F0F0F0Fu) | (((head.y >> 6) & 0x03030303u) << 4);
            uint mins = pair < 2 ? head.z & 0x3F3F3F3Fu : ((head.w >> 4) & 0x0F0F0F0Fu) | (((head.z >> 6) & 0x03030303u) << 4);
            uint shift = 16 * (pair % 2);
            float d = float(dd.x), dmin = float(dd.y);
            float sc1 = float((scales >> shift) & 0xFF), sc2 = float((scales >> (shift + 8)) & 0xFF);
            float m1 = float((mins >> shift) & 0xFF), m2 = float((mins >> (shift + 8)) & 0xFF);
            uint4 q = *((device const uint4 *)(block + 16 + 32 * pair + 16 * part));
            float lo = dot(nibbles(q.x), a0) + dot(nibbles(q.y), a1) + dot(nibbles(q.z), a2) + dot(nibbles(q.w), a3);
            float hi = dot(nibbles(q.x >> 4), c0) + dot(nibbles(q.y >> 4), c1) + dot(nibbles(q.z >> 4), c2) + dot(nibbles(q.w >> 4), c3);
            sums[r] += d * (sc1 * lo + sc2 * hi) - dmin * (m1 * sa + m2 * sc);
        }
    }
    for (uint r = 0; r < MATVEC_Q4_ROWS; r++) {
        float total = simd_sum(sums[r]);
        if (lane == 0 && row0 + r < p.rows) y[row0 + r] = total;
    }
}

// 8 bytes from a 2-byte aligned address, as two words.
static inline uint2 load8(device const uchar *p) {
    device const ushort *h = (device const ushort *)p;
    return uint2(uint(h[0]) | (uint(h[1]) << 16), uint(h[2]) | (uint(h[3]) << 16));
}

static inline float4 q6(uint low, uint high) { return float4(as_type<uchar4>(low | (high << 4))) - 32.0f; }

kernel void matvec_q6_K(device const uchar *w [[buffer(0)]], device const float *x [[buffer(1)]],
                        device float *y [[buffer(2)]], constant MatvecParams &p [[buffer(3)]],
                        uint group [[threadgroup_position_in_grid]], uint lane [[thread_index_in_simdgroup]],
                        uint simd [[simdgroup_index_in_threadgroup]], uint groups [[simdgroups_per_threadgroup]]) {
    uint row0 = (group * groups + simd) * MATVEC_ROWS;
    if (row0 >= p.rows) return;
    // Half h of the block (values 128h …), l from l0 to l0 + 7 with l0 = 16g + 8·part: scales sc[g], sc[g + 2], …
    uint j = lane % 8, h = j / 4, g = (j / 2) % 2, l0 = 16 * g + 8 * (j % 2);
    float sums[MATVEC_ROWS] = {0};
    for (uint b = lane / 8; b < p.blocksPerRow; b += 4) {
        device const float4 *xl = (device const float4 *)(x + b * 256 + 128 * h + l0);
        float4 x1a = xl[0], x1b = xl[1], x2a = xl[8], x2b = xl[9], x3a = xl[16], x3b = xl[17], x4a = xl[24], x4b = xl[25];
        for (uint r = 0; r < MATVEC_ROWS; r++) {
            if (row0 + r >= p.rows) break;
            device const uchar *block = w + (ulong)(row0 + r) * p.rowBytes + b * 210;
            float d = float(*((device const half *)(block + 208)));
            device const char *sc = (device const char *)(block + 192 + 8 * h + g);
            uint2 la = load8(block + 64 * h + l0), lb = load8(block + 64 * h + 32 + l0), qh = load8(block + 128 + 32 * h + l0);
            const uint m4 = 0x0F0F0F0Fu, m2 = 0x03030303u;
            float s1 = dot(q6(la.x & m4, qh.x & m2), x1a) + dot(q6(la.y & m4, qh.y & m2), x1b);
            float s2 = dot(q6(lb.x & m4, (qh.x >> 2) & m2), x2a) + dot(q6(lb.y & m4, (qh.y >> 2) & m2), x2b);
            float s3 = dot(q6((la.x >> 4) & m4, (qh.x >> 4) & m2), x3a) + dot(q6((la.y >> 4) & m4, (qh.y >> 4) & m2), x3b);
            float s4 = dot(q6((lb.x >> 4) & m4, (qh.x >> 6) & m2), x4a) + dot(q6((lb.y >> 4) & m4, (qh.y >> 6) & m2), x4b);
            sums[r] += d * (float(sc[0]) * s1 + float(sc[2]) * s2 + float(sc[4]) * s3 + float(sc[6]) * s4);
        }
    }
    for (uint r = 0; r < MATVEC_ROWS; r++) {
        float total = simd_sum(sums[r]);
        if (lane == 0 && row0 + r < p.rows) y[row0 + r] = total;
    }
}

// Q8_0 (34-byte blocks: fp16 d, then 32 signed bytes; 2-byte aligned): every lane takes one whole block of 32 values,
// so the 32 lanes read 32 neighbouring blocks of a row; two rows per SIMD group, the activations loaded once for both.
// Qwen3-VL in Q8_0 (the files with a Q8_0 LM head) needs it for every product of the decode.
kernel void matvec_q8_0(device const uchar *w [[buffer(0)]], device const float *x [[buffer(1)]],
                        device float *y [[buffer(2)]], constant MatvecParams &p [[buffer(3)]],
                        uint group [[threadgroup_position_in_grid]], uint lane [[thread_index_in_simdgroup]],
                        uint simd [[simdgroup_index_in_threadgroup]], uint groups [[simdgroups_per_threadgroup]]) {
    uint row0 = (group * groups + simd) * MATVEC_ROWS;
    if (row0 >= p.rows) return;
    float sums[MATVEC_ROWS] = {0};
    for (uint b = lane; b < p.blocksPerRow; b += 32) {
        device const float4 *xl = (device const float4 *)(x + b * 32);
        float4 xs[8];
        for (uint i = 0; i < 8; i++) xs[i] = xl[i];
        for (uint r = 0; r < MATVEC_ROWS; r++) {
            if (row0 + r >= p.rows) break;
            device const uchar *block = w + (ulong)(row0 + r) * p.rowBytes + b * 34;
            float d = float(*((device const half *)block));
            float s = 0;
            for (uint i = 0; i < 4; i++) {
                uint2 q = load8(block + 2 + 8 * i);
                s += dot(float4(as_type<char4>(q.x)), xs[2 * i]) + dot(float4(as_type<char4>(q.y)), xs[2 * i + 1]);
            }
            sums[r] += d * s;
        }
    }
    for (uint r = 0; r < MATVEC_ROWS; r++) {
        float total = simd_sum(sums[r]);
        if (lane == 0 && row0 + r < p.rows) y[row0 + r] = total;
    }
}

struct CacheParams {
    uint rows;       // rows of k and v [rows, kvHeads · 128]
    uint kvHeads;
    uint capacity;   // positions per head in the cache
    uint position;   // of the first row
};

// K (after its norm and RoPE) and V of `rows` positions into one layer's cache, fp16 [kvHeads, capacity, 128] each.
kernel void kv_store(device const float *k [[buffer(0)]], device const float *v [[buffer(1)]],
                     device half *kc [[buffer(2)]], device half *vc [[buffer(3)]], constant CacheParams &p [[buffer(4)]],
                     uint2 g [[thread_position_in_grid]]) {
    uint c = g.x, row = g.y;
    if (c >= p.kvHeads * 128 || row >= p.rows) return;
    uint head = c / 128;
    ulong at = ((ulong)head * p.capacity + p.position + row) * 128 + c % 128;
    kc[at] = half(k[(ulong)row * p.kvHeads * 128 + c]);
    vc[at] = half(v[(ulong)row * p.kvHeads * 128 + c]);
}

struct DecodeAttentionParams {
    uint keys;       // positions 0 … keys − 1 in the cache
    uint capacity;
    uint groups;     // query heads per key/value head
    float scale;     // 1 / √128
};

// One query per head against the cached keys (causal: all of them), as Qwen3's grouped attention: query head h reads
// key/value head h / groups. A threadgroup per query head, 8 SIMD groups each taking every 8th key with its own online
// softmax, each lane 4 of the 128 dimensions; the 8 partial results are merged at the end.
kernel void decode_attention(device const float *q [[buffer(0)]], device const half *kc [[buffer(1)]],
                             device const half *vc [[buffer(2)]], device float *out [[buffer(3)]],
                             constant DecodeAttentionParams &p [[buffer(4)]],
                             uint head [[threadgroup_position_in_grid]], uint lane [[thread_index_in_simdgroup]],
                             uint simd [[simdgroup_index_in_threadgroup]]) {
    threadgroup float partM[8], partL[8];
    threadgroup float4 partAcc[8][32];
    float4 qv = ((device const float4 *)(q + head * 128))[lane] * p.scale;
    ulong base = (ulong)(head / p.groups) * p.capacity * 128;
    float m = -INFINITY, l = 0;
    float4 acc = 0;
    for (uint j = simd; j < p.keys; j += 8) {
        float4 kv = float4(((device const half4 *)(kc + base + (ulong)j * 128))[lane]);
        float s = simd_sum(dot(qv, kv));
        float mNew = max(m, s);
        float correction = exp(m - mNew), weight = exp(s - mNew);
        l = l * correction + weight;
        acc = acc * correction + weight * float4(((device const half4 *)(vc + base + (ulong)j * 128))[lane]);
        m = mNew;
    }
    if (lane == 0) { partM[simd] = m; partL[simd] = l; }
    partAcc[simd][lane] = acc;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (simd == 0) {
        float mAll = -INFINITY;
        for (uint i = 0; i < 8; i++) mAll = max(mAll, partM[i]);
        float lAll = 0;
        float4 total = 0;
        for (uint i = 0; i < 8; i++) {
            if (partL[i] == 0) continue;   // a SIMD group without keys
            float f = exp(partM[i] - mAll);
            lAll += partL[i] * f;
            total += partAcc[i][lane] * f;
        }
        ((device float4 *)(out + head * 128))[lane] = total / lAll;
    }
}
