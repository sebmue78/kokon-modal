//! Fork: an LM head for text encoders whose GGUF has none (tied embeddings), so Prompt+ can write
//! text with them. Qwen3-VL 4B, the text encoder of FLUX.3 Image Klein and Krea 2, ties its output
//! layer to the token embeddings: llama.cpp's converter then writes no `output.weight`, and the
//! engine's text generation stops with "weights have no LM head" (Prompt+: "The prompt enhancer
//! failed"). Qwen-Image 2.1's Qwen3-VL 8B has its own head and needs nothing.
//!
//! The fix is a copy of the file with `output.weight` added as a copy of `token_embd.weight`: what
//! tied weights mean. The engine maps `output.weight` to its LM head. The downloaded file is never
//! changed (its size and SHA-256 stay as the catalog pins them); the copy sits next to it as
//! `<name>.lm-head.gguf` and is made once, on the first start that needs it.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

const MAGIC: &[u8; 4] = b"GGUF";
const EMBED: &str = "token_embd.weight";
const HEAD: &str = "output.weight";
const DEFAULT_ALIGNMENT: u64 = 32;

struct TensorInfo {
    name: String,
    dims: Vec<u64>,
    ggml_type: u32,
    offset: u64,
}

struct Header {
    version: u32,
    /// The key/value section as raw bytes (copied unchanged).
    kv: Vec<u8>,
    n_kv: u64,
    tensors: Vec<TensorInfo>,
    alignment: u64,
    /// Where the tensor data starts in the file.
    data_start: u64,
}

fn bad(why: &str) -> AppError {
    AppError::invalid(format!("Not a GGUF file Kokon Modal can read ({why})."))
}

fn u32_(r: &mut impl Read) -> AppResult<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).map_err(|_| bad("truncated"))?;
    Ok(u32::from_le_bytes(b))
}

fn u64_(r: &mut impl Read) -> AppResult<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b).map_err(|_| bad("truncated"))?;
    Ok(u64::from_le_bytes(b))
}

fn string(r: &mut impl Read) -> AppResult<String> {
    let n = u64_(r)?;
    if n > 1 << 20 {
        return Err(bad("string too long"));
    }
    let mut b = vec![0u8; n as usize];
    r.read_exact(&mut b).map_err(|_| bad("truncated"))?;
    String::from_utf8(b).map_err(|_| bad("text is not UTF-8"))
}

/// Size in bytes of a scalar GGUF value type; None for strings and arrays.
fn scalar_size(t: u32) -> Option<u64> {
    match t {
        0 | 1 | 7 => Some(1),
        2 | 3 => Some(2),
        4..=6 => Some(4),
        10..=12 => Some(8),
        _ => None,
    }
}

/// Skips one value of type `t`, returning it when it is a u32/u64 (for `general.alignment`).
fn skip_value(r: &mut (impl Read + Seek), t: u32) -> AppResult<Option<u64>> {
    if let Some(n) = scalar_size(t) {
        let mut b = [0u8; 8];
        r.read_exact(&mut b[..n as usize]).map_err(|_| bad("truncated"))?;
        return Ok(matches!(t, 4 | 10).then(|| u64::from_le_bytes(b)));
    }
    match t {
        8 => {
            let n = u64_(r)?;
            r.seek(SeekFrom::Current(n as i64)).map_err(|_| bad("truncated"))?;
        }
        9 => {
            let et = u32_(r)?;
            let n = u64_(r)?;
            match scalar_size(et) {
                Some(s) => {
                    r.seek(SeekFrom::Current((s * n) as i64)).map_err(|_| bad("truncated"))?;
                }
                None => {
                    for _ in 0..n {
                        skip_value(r, et)?;
                    }
                }
            }
        }
        _ => return Err(bad("unknown value type")),
    }
    Ok(None)
}

fn read_header(path: &Path) -> AppResult<Header> {
    let f = File::open(path).map_err(|e| AppError::io("open", path, e))?;
    let mut r = BufReader::with_capacity(1 << 20, f);
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic).map_err(|_| bad("truncated"))?;
    if &magic != MAGIC {
        return Err(bad("no GGUF signature"));
    }
    let version = u32_(&mut r)?;
    if version < 2 {
        return Err(bad("GGUF version 1"));
    }
    let n_tensors = u64_(&mut r)?;
    let n_kv = u64_(&mut r)?;
    let kv_start = r.stream_position().map_err(|e| AppError::io("read", path, e))?;
    let mut alignment = DEFAULT_ALIGNMENT;
    for _ in 0..n_kv {
        let key = string(&mut r)?;
        let t = u32_(&mut r)?;
        if let Some(v) = skip_value(&mut r, t)?
            && key == "general.alignment"
            && v > 0
        {
            alignment = v;
        }
    }
    let kv_end = r.stream_position().map_err(|e| AppError::io("read", path, e))?;
    let mut tensors = Vec::with_capacity(n_tensors as usize);
    for _ in 0..n_tensors {
        let name = string(&mut r)?;
        let nd = u32_(&mut r)?;
        if nd > 8 {
            return Err(bad("too many dimensions"));
        }
        let dims = (0..nd).map(|_| u64_(&mut r)).collect::<AppResult<Vec<_>>>()?;
        let ggml_type = u32_(&mut r)?;
        let offset = u64_(&mut r)?;
        tensors.push(TensorInfo { name, dims, ggml_type, offset });
    }
    let infos_end = r.stream_position().map_err(|e| AppError::io("read", path, e))?;
    let data_start = infos_end.div_ceil(alignment) * alignment;
    let mut kv = vec![0u8; (kv_end - kv_start) as usize];
    r.seek(SeekFrom::Start(kv_start)).map_err(|e| AppError::io("read", path, e))?;
    r.read_exact(&mut kv).map_err(|_| bad("truncated"))?;
    Ok(Header { version, kv, n_kv, tensors, alignment, data_start })
}

/// The file is a GGUF text encoder with token embeddings and no LM head of its own.
pub fn needs_head(path: &Path) -> bool {
    let is_gguf = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("gguf"));
    is_gguf
        && read_header(path).is_ok_and(|h| h.tensors.iter().any(|t| t.name == EMBED) && !h.tensors.iter().any(|t| t.name == HEAD))
}

/// Where the copy with an LM head lives: next to `path`, as `<stem>.lm-head.gguf`.
pub fn head_copy_path(path: &Path) -> PathBuf {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!("{stem}.lm-head.gguf"))
}

/// The copy is there, complete and not older than the file it was made from.
fn copy_is_current(src: &Path, dest: &Path) -> bool {
    let (Ok(s), Ok(d)) = (std::fs::metadata(src), std::fs::metadata(dest)) else { return false };
    let newer = match (s.modified(), d.modified()) {
        (Ok(s), Ok(d)) => d >= s,
        _ => true,
    };
    newer && d.len() > s.len() && read_header(dest).is_ok_and(|h| h.tensors.iter().any(|t| t.name == HEAD))
}

fn pad(w: &mut impl Write, at: u64, alignment: u64) -> std::io::Result<u64> {
    let to = at.div_ceil(alignment) * alignment;
    w.write_all(&vec![0u8; (to - at) as usize])?;
    Ok(to)
}

/// Writes `dest`: `src` with `output.weight` added as a copy of `token_embd.weight`.
pub fn write_head_copy(src: &Path, dest: &Path) -> AppResult<()> {
    let h = read_header(src)?;
    let embed = h.tensors.iter().find(|t| t.name == EMBED).ok_or_else(|| bad("no token embeddings"))?;
    let file_len = std::fs::metadata(src).map_err(|e| AppError::io("read", src, e))?.len();
    let data_len = file_len.checked_sub(h.data_start).ok_or_else(|| bad("truncated"))?;
    // The embeddings' bytes: up to the next tensor (or the end), so alignment padding comes along.
    let embed_end = h.tensors.iter().map(|t| t.offset).filter(|o| *o > embed.offset).min().unwrap_or(data_len);
    let embed_len = embed_end - embed.offset;
    let head_offset = data_len.div_ceil(h.alignment) * h.alignment;

    let tmp = dest.with_extension("gguf.part");
    let io = |e: std::io::Error| AppError::io("write the text encoder copy", &tmp, e);
    let result = (|| -> AppResult<()> {
        let mut w = BufWriter::with_capacity(8 << 20, File::create(&tmp).map_err(io)?);
        w.write_all(MAGIC).map_err(io)?;
        w.write_all(&h.version.to_le_bytes()).map_err(io)?;
        w.write_all(&(h.tensors.len() as u64 + 1).to_le_bytes()).map_err(io)?;
        w.write_all(&h.n_kv.to_le_bytes()).map_err(io)?;
        w.write_all(&h.kv).map_err(io)?;
        let info = |w: &mut BufWriter<File>, name: &str, dims: &[u64], t: u32, off: u64| -> std::io::Result<()> {
            w.write_all(&(name.len() as u64).to_le_bytes())?;
            w.write_all(name.as_bytes())?;
            w.write_all(&(dims.len() as u32).to_le_bytes())?;
            for d in dims {
                w.write_all(&d.to_le_bytes())?;
            }
            w.write_all(&t.to_le_bytes())?;
            w.write_all(&off.to_le_bytes())
        };
        let mut at = 4 + 4 + 8 + 8 + h.kv.len() as u64;
        for t in &h.tensors {
            info(&mut w, &t.name, &t.dims, t.ggml_type, t.offset).map_err(io)?;
            at += 8 + t.name.len() as u64 + 4 + 8 * t.dims.len() as u64 + 4 + 8;
        }
        info(&mut w, HEAD, &embed.dims, embed.ggml_type, head_offset).map_err(io)?;
        at += 8 + HEAD.len() as u64 + 4 + 8 * embed.dims.len() as u64 + 4 + 8;
        pad(&mut w, at, h.alignment).map_err(io)?;
        // The original data, then the embeddings again for the head.
        let mut input = File::open(src).map_err(|e| AppError::io("open", src, e))?;
        input.seek(SeekFrom::Start(h.data_start)).map_err(|e| AppError::io("read", src, e))?;
        let copied = std::io::copy(&mut (&mut input).take(data_len), &mut w).map_err(io)?;
        if copied != data_len {
            return Err(bad("truncated"));
        }
        pad(&mut w, data_len, h.alignment).map_err(io)?;
        input.seek(SeekFrom::Start(h.data_start + embed.offset)).map_err(|e| AppError::io("read", src, e))?;
        let copied = std::io::copy(&mut (&mut input).take(embed_len), &mut w).map_err(io)?;
        if copied != embed_len {
            return Err(bad("truncated"));
        }
        w.into_inner().map_err(|e| io(e.into_error()))?.sync_all().map_err(io)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, dest).map_err(|e| AppError::io("save the text encoder copy as", dest, e))
}

/// The text encoder file to launch the engine with: `path` itself, or (for a GGUF without an LM
/// head) its copy with one, made now if it is missing or out of date. Falls back to `path` when
/// the copy can't be made: the images still work, only Prompt+ does not.
pub fn text_encoder_for_launch(path: &Path) -> PathBuf {
    if !needs_head(path) {
        return path.to_path_buf();
    }
    let dest = head_copy_path(path);
    if copy_is_current(path, &dest) {
        return dest;
    }
    let started = std::time::Instant::now();
    match write_head_copy(path, &dest) {
        Ok(()) => {
            tracing::info!("text encoder without an LM head: wrote {} in {:.1} s (Prompt+)", dest.display(), started.elapsed().as_secs_f32());
            dest
        }
        Err(e) => {
            tracing::warn!("could not add an LM head to {} ({}); Prompt+ is not available with it", path.display(), e.message);
            path.to_path_buf()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny GGUF v3: one string key, `general.alignment`, an array key, and three tensors.
    fn write_gguf(path: &Path, with_head: bool) -> Vec<Vec<u8>> {
        let mut h: Vec<u8> = Vec::new();
        let s = |h: &mut Vec<u8>, v: &str| {
            h.extend((v.len() as u64).to_le_bytes());
            h.extend(v.as_bytes());
        };
        let tensors: Vec<(&str, Vec<u64>, usize)> = {
            let mut t = vec![("token_embd.weight", vec![4, 6], 48), ("blk.0.attn_q.weight", vec![4, 4], 32), ("output_norm.weight", vec![4], 16)];
            if with_head {
                t.push(("output.weight", vec![4, 6], 48));
            }
            t
        };
        h.extend(MAGIC);
        h.extend(3u32.to_le_bytes());
        h.extend((tensors.len() as u64).to_le_bytes());
        h.extend(3u64.to_le_bytes());
        s(&mut h, "general.architecture");
        h.extend(8u32.to_le_bytes());
        s(&mut h, "qwen3vl");
        s(&mut h, "general.alignment");
        h.extend(4u32.to_le_bytes());
        h.extend(32u32.to_le_bytes());
        s(&mut h, "tokenizer.ggml.tokens");
        h.extend(9u32.to_le_bytes());
        h.extend(8u32.to_le_bytes());
        h.extend(2u64.to_le_bytes());
        s(&mut h, "a");
        s(&mut h, "bc");
        let mut off = 0u64;
        let mut blobs = Vec::new();
        for (name, dims, len) in &tensors {
            s(&mut h, name);
            h.extend((dims.len() as u32).to_le_bytes());
            for d in dims {
                h.extend(d.to_le_bytes());
            }
            h.extend(1u32.to_le_bytes()); // F16
            h.extend(off.to_le_bytes());
            blobs.push((0..*len).map(|i| (i as u8).wrapping_mul(7).wrapping_add(name.len() as u8)).collect::<Vec<u8>>());
            off += (*len as u64).div_ceil(32) * 32;
        }
        while h.len() % 32 != 0 {
            h.push(0);
        }
        for b in &blobs {
            h.extend(b);
            while h.len() % 32 != 0 {
                h.push(0);
            }
        }
        std::fs::write(path, h).unwrap();
        blobs
    }

    fn tensor_bytes(path: &Path, name: &str, len: usize) -> Vec<u8> {
        let h = read_header(path).unwrap();
        let t = h.tensors.iter().find(|t| t.name == name).unwrap();
        let bytes = std::fs::read(path).unwrap();
        let at = (h.data_start + t.offset) as usize;
        bytes[at..at + len].to_vec()
    }

    /// The real Qwen3-VL 4B GGUF (or its first megabytes): `QLS_TEST_GGUF=<path> cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn reads_a_real_text_encoder() {
        let Ok(p) = std::env::var("QLS_TEST_GGUF") else { return };
        let h = read_header(Path::new(&p)).unwrap();
        let e = h.tensors.iter().find(|t| t.name == EMBED).unwrap();
        println!("{} tensors, alignment {}, data at {}, token_embd {:?} type {} at {}", h.tensors.len(), h.alignment, h.data_start, e.dims, e.ggml_type, e.offset);
        assert!(h.tensors.iter().all(|t| t.name != HEAD), "Qwen3-VL 4B ties its head");
    }

    #[test]
    fn adds_the_tied_head_as_a_copy_of_the_embeddings() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("Qwen3VL-4B-Instruct-Q8_0.gguf");
        let blobs = write_gguf(&src, false);
        assert!(needs_head(&src));
        let dest = head_copy_path(&src);
        assert_eq!(dest.file_name().unwrap(), "Qwen3VL-4B-Instruct-Q8_0.lm-head.gguf");
        write_head_copy(&src, &dest).unwrap();
        let h = read_header(&dest).unwrap();
        assert_eq!(h.tensors.len(), 4);
        assert_eq!(h.alignment, 32);
        let head = h.tensors.iter().find(|t| t.name == HEAD).unwrap();
        assert_eq!((head.dims.clone(), head.ggml_type), (vec![4, 6], 1));
        assert_eq!(head.offset % 32, 0);
        // Every original tensor is unchanged, and the head holds the embeddings.
        assert_eq!(tensor_bytes(&dest, "token_embd.weight", 48), blobs[0]);
        assert_eq!(tensor_bytes(&dest, "blk.0.attn_q.weight", 32), blobs[1]);
        assert_eq!(tensor_bytes(&dest, "output_norm.weight", 16), blobs[2]);
        assert_eq!(tensor_bytes(&dest, HEAD, 48), blobs[0]);
        assert!(!needs_head(&dest));
        assert!(!dest.with_extension("gguf.part").exists());
    }

    #[test]
    fn launch_uses_the_copy_once_and_leaves_files_with_a_head_alone() {
        let dir = tempfile::tempdir().unwrap();
        let tied = dir.path().join("te.gguf");
        let src_bytes = {
            write_gguf(&tied, false);
            std::fs::read(&tied).unwrap()
        };
        let first = text_encoder_for_launch(&tied);
        assert_eq!(first, head_copy_path(&tied));
        let made = std::fs::metadata(&first).unwrap().modified().unwrap();
        // The second start reuses it; the downloaded file was never touched.
        assert_eq!(text_encoder_for_launch(&tied), first);
        assert_eq!(std::fs::metadata(&first).unwrap().modified().unwrap(), made);
        assert_eq!(std::fs::read(&tied).unwrap(), src_bytes);

        let own = dir.path().join("8b.gguf");
        write_gguf(&own, true);
        assert!(!needs_head(&own));
        assert_eq!(text_encoder_for_launch(&own), own);
        let st = dir.path().join("te.safetensors");
        std::fs::write(&st, b"not gguf").unwrap();
        assert_eq!(text_encoder_for_launch(&st), st, "only GGUF files");
        let broken = dir.path().join("broken.gguf");
        std::fs::write(&broken, b"GGUF").unwrap();
        assert_eq!(text_encoder_for_launch(&broken), broken, "unreadable: as is");
    }
}
