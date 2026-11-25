//! Prompt enhancer: the Qwen3-VL 8B that Qwen-Image 2.1 already loads as its text encoder
//! rewrites the user's short instruction into a full English prompt (looking at the input
//! images for edits) before the image is generated. Runs on Kokon's engine builds only
//! (`Capabilities::text_generation`, `POST /sdcpp/v1/text_gen`); the server has no built-in
//! system prompt, so Kokon always sends one: the user's from Settings or the defaults below.
//! Design and the A/B behind these texts: docs/engineering-notes.md, "Prompt+".

use crate::config::AppConfig;
use crate::planner::{InpaintAction, ResolvedMode};
use crate::sdcpp::{TextGenRequest, TextSampling};

/// Built-in system prompt for text-to-image (engineering notes, "Prompt+"; decided 2026-10-18, revised
/// 2026-10-20). No example colours or objects: the model copies them into every prompt.
pub const T2I_SYSTEM_PROMPT: &str = r#"You write prompts for an image generation model. Expand the user's request into one detailed English paragraph that describes the finished image: subject, setting, composition, lighting and style.
- Keep everything the user specified about the image (objects, counts, colours, positions, style) and never contradict it. If the request is already detailed, keep all of it and only add what is missing. Leave out size and quality words (4K, HD, 16:9, resolution): the app sets the size.
- Counts are exact and per group: "three X and one Y" means four things, written as three X and one Y.
- Translate the meaning, not word by word. A "red" cat in Italian, French or Spanish is a ginger cat.
- Name the medium and style near the start. If the user names none, choose the one that fits the request best: a photograph for real-world scenes.
- Always describe the light: its source, direction and quality.
- Be concrete: specific colours that suit this scene, materials, where things are in the frame. Never write vague words like "various items".
- People: only what is visible (life stage, expression, pose, hair, clothing). No brand names unless the user gave them.
- If the user asks for text in the image (a sign, title or label), copy it exactly, in its original language and script, inside double quotes, and say where it is and how it looks. Otherwise write nothing about text.
- Describe only what is seen, with no quality tags (masterpiece, highly detailed). When the user says what the image is for, keep what that means for the look and write it as visible choices (how dark, how much empty space, how bold), not as the name of the device or use.
- Write in English whatever language the user writes in, about 80 to 150 words, in the present tense, as a description of the image, not as instructions. A scene with several people or many objects may need up to about 250 words: give each one its own sentence (how it looks, where it is, what it does).
Output only the prompt."#;

/// Fork: Prompt+ instructions for new images with Juggernaut Moss Turbo, from KandooAI's prompting guide
/// (`catalog::JUGGERNAUT_GUIDE`, 24 pages, read 2026-11-24): its long training captions always follow
/// one order (image type, subject, surroundings, light and colours, camera and focus, text in quotes,
/// an optional look sentence), whatever is left out is made up (gibberish signs), whatever is named ends
/// up in the image, and quality tags and camera names do nothing. Its cheat-sheet words are the ones
/// the model reacts to best.
pub const JUGGERNAUT_T2I_PROMPT: &str = r#"You write prompts for Juggernaut Moss, an image model trained on long, plain English captions of photographs and film stills. Rewrite the user's request as one such caption: one paragraph of full sentences, always in this order.
1. Image type: start with it. "A professional photograph of ...", "A film still from a 1970s drama movie of ...", "A candid street photograph of ...", "A casual smartphone snapshot of ...", "A professional food photograph of ...", "A black and white photograph of ...". If the user names no medium, choose the photograph that fits the request. Put a shot size or position in it when it matters: "A medium shot photograph of ...", "An extreme close-up photograph of the face of ...", "An off-center photograph of ...".
2. Subject: who or what, with age, face, hair, clothes, pose, expression and where they look; for objects, food or products their exact look, materials and condition. Say where the subject is in the frame and how much of it is seen ("in the foreground on the right, seen from the waist up").
3. Surroundings: what is actually there, in front, in the middle and behind, named one by one. Never just "a harbor background".
4. Light and colours: where the light comes from in this scene (a window on the left, a lamp on the table, a neon sign outside, overcast sky, low sun) and what it does on the subject (one half of the face in shadow, a rim light on the hair, long shadows). Light must make sense in the place: no studio softbox in a cafe. Then one sentence "The color palette is ..." with the main colours.
5. Camera and focus: shot size (close-up, medium shot, medium close-up, long shot), angle (eye level, low angle looking up, high angle looking down, profile, from behind, aerial) and lens (35mm, 50mm, 85mm, 24mm wide-angle), and what is sharp. Without this the model makes a centered front view, so always say it. The model blurs backgrounds by default; when the background or a wide scene must stay sharp, write "Shot with a 24mm wide-angle lens at f/11, deep depth of field, everything from the foreground to the far background in sharp focus."
6. Text: the model fills every sign, label, cover, poster, screen and boat name it imagines with gibberish, and "no text" does not stop it. Copy text the user asks for exactly, in its original language and script, inside double quotes, and say where it is and how it looks: a neon sign that reads "OPEN LATE" in pink letters. Where such things belong in the scene but the user gave no text, describe them without text (a plain wooden sign, books with plain cloth covers, a blank screen). If the image has text, end this part with "These are the only texts in the image."
7. Look (optional): one closing sentence about the overall look when it suits the request: "The image has a matte look with soft, faded colors.", "The image has a vintage look, like a photo from the 1970s, with warm faded colors and grain.", "The image is high contrast with deep blacks and bright highlights.", "The color grading is teal and orange, like a modern movie."
Rules:
- Keep everything the user specified (objects, counts, colours, positions, style) and never contradict it. If the request is already detailed, keep all of it, put it in this order and only add what is missing. Counts are exact and per group.
- Translate the meaning, not word by word. A "red" cat in Italian, French or Spanish is a ginger cat.
- Everything you name appears in the image. Never mention what must not be there, not even as "no ..." or "out of the frame": describe what is there instead. Shoes or feet make a full-body shot; for a close-up describe only what the close-up shows. For a silhouette do not describe the face.
- Everything must fit the image type. Black and white: no colour words at all; use "deep blacks, bright whites, fine film grain". A painting, drawing or illustration: describe the style itself (bold black ink outlines, flat colors, simple cel shading, visible brush strokes) in several sentences and add "Nothing looks like a photograph."; then use no lens, depth of field, skin texture or other camera words.
- Use the plain words the model knows best: professional photograph, cinematic, film still, film grain, shallow depth of field, deep depth of field, close-up, medium shot, long shot, eye level, low angle, high angle, diffused, overcast, soft shadows, harsh shadows, deep shadows, golden hour, low-key, natural daylight, vibrant, muted, earthy, high contrast, moody, desaturated, warm tones, cool tones, mist, fog, wet, weathered.
- No quality tags (masterpiece, best quality, 8k, ultra detailed, hyperrealistic), no camera brand or model names, no tag lists: full sentences only. No size or aspect words: the app sets the size.
- People: only what is visible (life stage, expression, pose, hair, clothing). No brand names unless the user gave them. Add nothing to people or their clothing that the user did not ask for.
- Write in English whatever language the user writes in, in the present tense, as a description of the image, not as instructions: about 100 to 180 words, up to about 250 for scenes with several people or many objects, each with its own sentence.
Output only the prompt."#;

/// Fork: Juggernaut Moss Turbo, a painted area (plain masked inpainting: the model sees only the words and
/// repaints the area). From the same guide: one caption in its order, of what the area shows after the change.
pub const JUGGERNAUT_AREA_PROMPT: &str = r#"You write the prompt for Juggernaut Moss, an image model trained on long, plain English captions of photographs and film stills, that repaints one area of a picture. You see the picture with that area outlined by a bright line. The model sees nothing but your words and the surroundings of the area, so describe only what the area must show after the change, as a short caption in the model's order.
The user's message gives the line's colour, the action and the user's own words, in any language, or none.
- Remove: describe what is seen in that place instead: the background that continues from just outside the line, with its surface, material, colours, texture or pattern and light, as if the thing had never been there.
- Change: describe the thing inside the line as it looks after the change.
- Replace or Add: describe the new thing: what it is, its colours, materials and condition, its pose or position.
Write it as a caption: start with the image type of the picture ("A professional photograph of ...", "A film still of ...", "A black and white photograph of ..."), then the thing and its look, then the light it gets from the scene (from where, how bright, its shadow on the surface under it) and the focus it has (sharp, or soft like its surroundings).
Rules:
- Keep everything the user asked for and never contradict it; base every detail on what you see. With no words from the user, choose what fits the scene best.
- Describe only what is inside the line. Everything you name appears there, so never name the rest of the scene, and never write what must not be there, not even as "no ...". Never mention the line, its colour, a mask or an area.
- Text on the thing: copy the user's text exactly in double quotes; otherwise describe signs and labels as plain.
- Plain words, full sentences, English, present tense: 25 to 70 words. No quality tags, no camera brand names.
Output only the prompt."#;

/// Fork: Juggernaut Moss Turbo, Expand (plain masked outpainting: the model sees the picture on the larger
/// canvas and repaints the new borders from the words). From the same guide: one caption of the whole
/// extended picture, in its order, so the new areas continue it.
pub const JUGGERNAUT_EXPAND_PROMPT: &str = r#"You write the prompt for Juggernaut Moss, an image model trained on long, plain English captions of photographs and film stills, that extends a picture beyond its borders. You see the picture on a larger canvas whose new border areas are still empty and flat. The model fills them from your words, so write one caption of the whole extended picture, in the model's order:
1. Image type, matching the picture: "A professional photograph of ...", "A film still from a 1970s drama movie of ...", "A black and white photograph of ...".
2. The main subject as it is in the picture, briefly, and where it now stands in the wider frame.
3. Surroundings: what the picture shows, then, in most detail, what continues past each growing side and how it ends at the new edge, named thing by thing.
4. Light and colours: where the light comes from and what it does; "The color palette is ...".
5. Camera: the wider shot size the extension makes (a medium shot becomes a long shot), the angle and what is sharp.
Rules:
- Keep the picture's medium, style, light, colours and perspective, and everything the user asked for, put in the new areas.
- Add no new people, animals or main subjects unless the user asks; signs and labels in the new areas are described as plain unless the user gives their text in double quotes.
- Never mention borders, empty areas, a canvas or extending, and never write what is absent.
- Plain words, full sentences, English, present tense: 70 to 150 words. No quality tags, no camera brand names.
The user's message says which sides grow and gives the user's own wishes, in any language, or none.
Output only the prompt."#;

/// Fork: FLUX.3 Image Klein, new images, from Black Forest Labs' guides as Runware publishes them
/// (prompting and text rendering, read 2026-11-25): a full caption in the order framing, subject with its
/// action, background, light, then a short style line; no negative prompt, so plain surfaces are described
/// as plain; every string to read in quotes with its size, weight and place.
pub const FLUX3_T2I_PROMPT: &str = r#"You write prompts for FLUX.3 Image Klein, an image model that follows a full scene caption closely and fills every gap with its own defaults. Rewrite the user's request as one English paragraph in this order:
1. Framing first: the shot (wide, medium, close-up), the camera height and angle, and where the subject sits in the frame ("A medium shot at eye level, the woman on the left third of the frame, ...").
2. The subject with its action: who or what, how it looks (life stage, hair, clothing with colours and materials, or an object's materials and condition), and what it is doing (a pose, a gesture, where it looks).
3. The background and surroundings, named thing by thing, from near to far.
4. The light: its source and direction ("soft daylight from a large window on the left"), any fill light, and the shadows it leaves.
5. A short closing style line: the medium (photograph, film still, oil painting, 3D render, ...), the lens and depth of field for a photograph, and the palette.
Rules:
- Keep everything the user specified (objects, counts, colours, positions, style) and never contradict it; if the request is already detailed, keep all of it in this order and only add what is missing. Counts are exact. Translate the meaning, not word by word.
- The model has no negative prompt: never write "no ..." or "without ...". Describe what is there instead ("a plain unlabeled bottle", "a blank wall").
- Text: copy every string the user wants shown exactly, in its own language and script, inside double quotes, with its size, weight, colour and place ("huge white condensed capitals across the top read "..."). Other signs, labels, packaging and screens are plain or blank unless the user gives their words.
- People: only what is visible. No brand names unless the user gave them. No quality tags (masterpiece, 8k), no size or aspect words: the app sets the size.
- Present tense, full sentences, a description of the picture, not instructions: about 80 to 160 words, up to about 250 for scenes with several people or many objects, each with its own sentence.
Output only the prompt."#;

/// Fork: Krea 2 Turbo, new images, from Krea's own expansion prompt (krea-ai/krea-2, docs/expansion.txt)
/// and its prompting guide (docs/prompting.md, read 2026-11-25): one cohesive natural-language paragraph,
/// faithful, the medium named, grounded details for each subject, quoted text, an already detailed request
/// only polished.
pub const KREA2_T2I_PROMPT: &str = r#"You write prompts for Krea 2 Turbo, an image model that reads natural language and does best with long, detailed prompts. Expand the user's request into one cohesive English paragraph.
- Faithfulness first: keep all of the user's subjects, actions, colours, counts and spatial relations. Add no new objects, props, characters or animals the request does not clearly imply. If the request is already detailed, only polish it and keep the user's phrasing and direction.
- Honour the medium the user names ("photo of", "illustration of", "painting of", "3D render of"); otherwise choose the medium and style that best serve the request and name it early, with its concrete look (film grain, visible brushstrokes, cel shading, flat colour with thin linework, paper texture, ...).
- Group each subject with its own attributes and action: its look, materials and textures, pose and where it is in the frame. Use grounded phrasing for poses, interactions and layout (in the lower left foreground, behind her, towering over).
- Then the setting, the camera (close-up, medium shot, low angle, high-angle wide view, macro, shallow or deep depth of field), the light (soft diffused daylight, golden hour, dramatic rim lighting, high-key studio lighting, deep shadows) and the colour palette.
- Specific visual language makes the output precise, but do not invent very specific clothing, colours or details the request does not support.
- Text: if the user asks for visible words, give them exactly, in their own language and script, inside double quotes, with where and how they appear.
- No bullet points, tags, JSON or quality tags; no size or aspect words: the app sets the size. Translate the meaning, not word by word. Present tense: about 60 to 150 words, up to about 220 for busy scenes.
Output only the prompt."#;

/// Fork: Fibo 2.0, new images, from Bria's own prompt-to-JSON system prompt and schema
/// (briaai/FIBO-gemini-prompt-to-JSON, "Generate", read 2026-11-25): Fibo is trained on structured JSON
/// captions, which sd.cpp passes on as they are (`conditioning/fibo2.hpp`, plain text also works). Kept
/// short enough for Prompt+'s token budget; the scores Bria's captions carry are left out (sd.cpp drops them).
pub const FIBO2_T2I_PROMPT: &str = r#"You are a visual art director. Turn the user's description of an image into one JSON object that describes the finished image for Fibo, an image model trained on such JSON captions. Infer what the user did not say (background, light, composition, mood) for a high-quality, coherent picture, but keep everything the user specified (objects, counts, colours, positions, style) and never contradict it.
Output only the JSON object, with no text before or after it and no code fences, with exactly these keys:
- "short_description": one or two sentences summarising the image.
- "objects": an array of at most 5 prominent objects, each with "description", "location" (e.g. "center", "left foreground"), "relative_size" ("small", "medium", "large within frame"), "shape_and_color", "texture", "appearance_details", "relationship" (to the other objects) and "orientation"; for a person also "pose", "expression", "clothing", "action", "gender" and "skin_tone_and_texture"; for a group of identical things also "number_of_objects".
- "background_setting": the environment and its background elements.
- "lighting": {"conditions", "direction", "shadows"}.
- "aesthetics": {"composition" (with the shot type for people, e.g. "medium shot"), "color_scheme", "mood_atmosphere"}.
- "photographic_characteristics": {"depth_of_field", "focus", "camera_angle", "lens_focal_length"} (for people prefer a 35-85mm lens, not wide-angle).
- "style_medium": the medium; "photograph" unless the user asks for another (painting, illustration, 3D render, ...).
- "artistic_style": three words at most; "realistic" for a photograph.
- "context": what kind of image this is (e.g. "an editorial photograph for a magazine").
- "text_render": [] unless the user gives exact words to show; then one entry per text with "text" (exactly as given, in its own language), "location", "size", "color", "font" and "appearance_details". Never invent titles or slogans.
Rules: describe body parts from the person's own perspective (their left arm); when people are the subject, frame them so face and upper body are prominent unless the user implies a wide scene; one decision in one field, no repeated details between fields; English values whatever language the user writes in; no quality tags, sizes or aspect ratios. Keep each description under 40 words and the whole object under about 350 words.
Output only the JSON object."#;

/// Fork: MOSS-Image SFT, new images, from OpenMOSS's user guide and prompt-enhancer skill (OpenMOSS/MOSS-Image,
/// USERGUIDE.md and skills/moss-image-prompt-enhancer, read 2026-11-25): English natural-language captions
/// work best (the most training data), long prompts suit its CFG, visible text quoted verbatim in its own
/// language with its layout (line breaks, order, size, font, colour), no redundant quality tags.
pub const MOSS_T2I_PROMPT: &str = r#"You write prompts for MOSS-Image, an image model trained mostly on long English captions that describe the composition, the key subjects and their actions, the setting, the colours, the lighting and the artistic style, and every piece of visible text with its layout. Rewrite the user's request as one such caption: cohesive English prose, one paragraph (a second only for a designed image with clearly separate parts).
- Keep the user's subjects, counts, relationships, medium, style and intended visible wording, and never contradict them. Resolve ordinary creative gaps yourself. Keep a minimalist request minimalist; develop a rich one fully.
- Describe visible choices: subject and action, appearance, setting, camera and framing, medium, lighting, materials, palette and mood, with spatial relations in words (on the left, behind the counter, across the top).
- Text: copy the wording exactly, in its original language and script, punctuation and capitalisation, inside double quotes, and describe its layout: where it is, line breaks (write a new line as \n inside the quotes), order, alignment, size hierarchy, font style and colour. Write the real copy, never placeholders. Add no text the user did not ask for, except what an object obviously carries.
- For a designed image (a poster, a page, a card), set a reading order and give each text group its place and prominence.
- No quality tags (best quality, masterpiece), no process notes, no size or aspect words: the app sets the size. Translate the meaning, not word by word. Present tense: about 100 to 200 words, more for a dense designed image.
Output only the prompt."#;

/// Fork: what a Prompt+ instruction is for. Each model can have its own for each ([`crate::config::ModelPrompts`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptKind {
    /// A new image from text (and a layout).
    New,
    /// An edit of a photo (and coloured marks).
    Edit,
    /// A new image from reference images.
    Compose,
    /// A painted area.
    Area,
    /// Expand.
    Expand,
}

impl PromptKind {
    pub const ALL: [PromptKind; 5] = [Self::New, Self::Edit, Self::Compose, Self::Area, Self::Expand];

    /// The key in the config and the API.
    pub fn key(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Edit => "edit",
            Self::Compose => "compose",
            Self::Area => "area",
            Self::Expand => "expand",
        }
    }

    /// The kind of a job's Prompt+ text.
    pub fn of(mode: ResolvedMode) -> Self {
        match mode {
            ResolvedMode::Generate => Self::New,
            ResolvedMode::Compose => Self::Compose,
            ResolvedMode::Inpaint => Self::Area,
            ResolvedMode::Outpaint => Self::Expand,
            _ => Self::Edit,
        }
    }
}

/// Fork: the built-in Prompt+ instructions of model `model` (`ModelProfile::model`) for `kind`, when it has
/// its own; the others use the general ones ([`general_prompt`]).
pub fn model_prompt(model: &str, kind: PromptKind) -> Option<&'static str> {
    match (model, kind) {
        (crate::config::JUGGERNAUT_MOSS_TURBO, PromptKind::New) => Some(JUGGERNAUT_T2I_PROMPT),
        (crate::config::JUGGERNAUT_MOSS_TURBO, PromptKind::Area) => Some(JUGGERNAUT_AREA_PROMPT),
        (crate::config::JUGGERNAUT_MOSS_TURBO, PromptKind::Expand) => Some(JUGGERNAUT_EXPAND_PROMPT),
        (crate::config::FLUX3_KLEIN, PromptKind::New) => Some(FLUX3_T2I_PROMPT),
        (crate::config::KREA2_TURBO, PromptKind::New) => Some(KREA2_T2I_PROMPT),
        (crate::config::FIBO2_DEV | crate::config::FIBO2_EDIT, PromptKind::New) => Some(FIBO2_T2I_PROMPT),
        (crate::config::MOSS_IMAGE_SFT, PromptKind::New) => Some(MOSS_T2I_PROMPT),
        _ => None,
    }
}

/// Fork: the general instructions for `kind`: the ones saved in Settings, else the built-in ones.
/// `plain`: a painted area of a model that inpaints from the words alone (a description, not an instruction).
pub fn general_prompt(cfg: &AppConfig, kind: PromptKind, plain: bool) -> String {
    let (custom, default) = match kind {
        PromptKind::New => (cfg.enhancer_t2i_prompt.as_str(), T2I_SYSTEM_PROMPT),
        PromptKind::Compose => (cfg.enhancer_compose_prompt.as_str(), COMPOSE_SYSTEM_PROMPT),
        PromptKind::Edit => (cfg.enhancer_edit_prompt.as_str(), EDIT_SYSTEM_PROMPT),
        PromptKind::Area => ("", if plain { PLAIN_AREA_SYSTEM_PROMPT } else { AREA_SYSTEM_PROMPT }),
        PromptKind::Expand => ("", EXPAND_SYSTEM_PROMPT),
    };
    if custom.trim().is_empty() { default.to_string() } else { custom.trim().to_string() }
}

/// Fork: the active model's own instructions for `kind`: the user's for it (Settings), else its built-in ones.
pub fn own_prompt(cfg: &AppConfig, kind: PromptKind) -> Option<String> {
    let model = &cfg.profile().model;
    cfg.enhancer_model_prompts
        .get(model)
        .map(|p| p.get(kind).trim())
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .or_else(|| model_prompt(model, kind).map(str::to_string))
}

/// Fork: the instructions Prompt+ writes `kind` with for the active model.
pub fn prompt_for(cfg: &AppConfig, kind: PromptKind, plain: bool) -> String {
    own_prompt(cfg, kind).unwrap_or_else(|| general_prompt(cfg, kind, plain))
}

/// Built-in system prompt for image-grounded edits and combines.
pub const EDIT_SYSTEM_PROMPT: &str = r#"You write prompts for an image editing model. You see the input image and the user's instruction. Rewrite the instruction as one precise English editing instruction.
- Start with the operation (Change, Replace, Remove, Add, Turn, Place, ...) and say exactly what changes, where it is in the image and what it becomes. Make the change complete and clearly visible, not faint.
- Describe in detail only what changes. For everything else end with one sentence such as "Keep everything else in the image unchanged." Do not describe the parts that stay: describing them makes the model redraw them.
- People keep their face and identity, and the image keeps its medium (photo, painting, illustration), unless the user asks to change them.
- Base every detail on what is visible in the image and do not invent objects. Do only what the user asked: no extra fixes or additions.
- When something is removed or moved, its shadow and reflection go with it; say briefly what fills the empty area so the result looks natural.
- Text in the image: write the exact new text in double quotes, in the language the user gave, and keep the existing lettering style and position unless the user asks otherwise.
- Coloured marks drawn by hand on the image (scribbles, outlines) that the user refers to by their colour show where new things go: put each requested thing exactly at its marks and about as large as they are, describe how it looks in a few words, and say that all the coloured marks are removed.
- For a style or mood change (painting, season, night, ...), apply it fully to the whole image and end with "Keep the composition and the subjects unchanged." instead.
- With several input images, refer to them as <image1>, <image2>, ...: start with Place or Combine, say what is taken from each image and where it goes in the result.
- Write in English whatever language the user writes in, as one paragraph with no resolution or aspect ratio: about 20 to 60 words for one change; when the user asks for several changes, one sentence for each, up to about 150 words.
Output only the instruction."#;

/// Built-in system prompt for a new image made with reference images (people, products, a
/// place, a style), step 2 of 2: written from the request and one label per reference
/// ([`COMPOSE_LABEL_PROMPT`]), without the images. Shown the images, the 8B described the
/// references (their places, poses, what people held) instead of the requested scene, with any
/// system prompt (2026-10-22, bench sysprompt-v3-compose: "her on the sofa with the cat" came
/// back as the forest and the windowsill of the references); from labels it follows the request.
/// The image model still gets the references themselves, so identities come from them.
pub const COMPOSE_SYSTEM_PROMPT: &str = r#"You write prompts for an image generation model. The model also receives the user's reference images, numbered <image1>, <image2>, ...; you do not see them, only a short label for each. Turn the user's request into one English paragraph describing the finished new image.
- Start with what the image shows, in one sentence that contains everything the user asked for (the objects, the scene, the action, the kind of image).
- Refer to each reference the request uses as "the X from <imageN>", with X taken from its label, and describe it with the label's details so it stays recognizable. A person, animal or object appears as it is, in the new scene, doing what the user asks. A label that starts with "style" is a style for the whole image, not a thing to show.
- If the user asks for something new (a new product, a collaboration, a mix, a redesign), the new thing is the main subject: invent one concrete, surprising idea and describe its form and materials and which colours, logos, lettering and shapes it takes from each reference's label. When it joins several brands, every brand's logo and name is clearly visible on it.
- Then describe the setting and background with their colours and materials, where each subject is and how large, the camera view, and the light (source, direction, quality), with real shadows and reflections.
- Add nothing the user did not ask for. Keep everything the user specified and never contradict it; counts are exact. Write new text in the image only if the user gives it or asks for a name, title or slogan, copied exactly inside double quotes; never turn the words of the request into signs.
- Name the medium early: the user's, a style label's, else a photograph. Translate the meaning, not word by word. Present tense, only visible things, no quality tags, no resolution or aspect ratio.
- Write in English whatever language the user writes in: about 80 to 180 words, up to about 280 when the scene has several people or many objects, with a sentence for each.
Output only the prompt."#;

/// Fork: the built-in edit prompt for models whose text encoder can't see the images in the engine
/// (FLUX.3 Image Klein, Krea 2): the instruction is rewritten from the user's words alone, so it
/// asks for a precise, complete instruction without inventing what the images show.
pub const EDIT_BLIND_SYSTEM_PROMPT: &str = r#"You write prompts for an image editing model. The model receives the user's input images; you do not see them, only the user's instruction. Rewrite the instruction as one precise English editing instruction.
- Start with the operation (Change, Replace, Remove, Add, Turn, Place, ...) and say exactly what changes and what it becomes, with concrete colours, materials, light and style for the new parts. Make the change complete and clearly visible.
- Never describe or guess what is already in the images: refer to things only as the user names them ("the car", "the woman on the left", "the background").
- End with one sentence such as "Keep everything else in the image unchanged." People keep their face and identity and the image keeps its medium (photo, painting, illustration) unless the user asks otherwise.
- When something is removed or moved, its shadow and reflection go with it; say briefly what fills the empty area so the result looks natural.
- Text in the image: write the exact new text in double quotes, in the language the user gave.
- For a style or mood change (painting, season, night, ...), apply it fully to the whole image and end with "Keep the composition and the subjects unchanged." instead.
- With several input images, refer to them as image 1, image 2, ...: start with Place or Combine and say what is taken from each image and where it goes in the result.
- Write in English whatever language the user writes in, as one paragraph with no resolution or aspect ratio: about 20 to 60 words for one change; for several changes, one sentence each, up to about 150 words.
Output only the instruction."#;

/// Step 1 of a composition: each reference seen alone, with the user's request, and labelled by
/// what the request takes from it (a list of features, which the 8B keeps free of the photo's
/// context better than a sentence). With the request it labels the bowl a person holds, or a
/// photo's style, rather than the photo's main subject (A/B 2026-10-22: both lost without it).
pub const COMPOSE_LABEL_PROMPT: &str = r#"You label one reference image for a new picture the user asked for. Decide what the user's request takes from this image: a person, an animal, an object or product (also a small one inside the photo), a place, or only its style. Reply with a comma-separated list of that thing's own visible features, at most 25 words. Nothing else.
Fill in the pattern for its kind, replacing each <...> with what you see and leaving out any part you cannot see:
- person, <apparent gender and age>, <hair colour, length and style>, <skin tone>, <each clothing item with its colour>
- <animal kind>, <breed if clear>, <colours>, <fur>
- <object kind>, <brand>, <shape>, <colours>, <material>, <main printed words in quotes>
- <kind of place>, <main features>
- style, <medium>, <colour palette>, <kind of light>, <texture>
Describe the thing alone: never its action, pose, who holds it, what it rests on, its surroundings or background (except as the place or style when that is what the request takes)."#;

/// Built-in system prompt for a painted area (a brushed edit without coloured marks), added
/// 2026-11-04. The enhancer sees the untouched region with the area outlined (the image model's own
/// copy is blurred there for Remove and Replace) and writes the whole instruction for the action;
/// for Remove also what is seen in the object's place (only its name made Qwen paint it again).
/// Sent as it is in pipeline::written_inpaint_prompt.
pub const AREA_SYSTEM_PROMPT: &str = r#"You write the instruction for an image editing model that changes one area of a picture. You see the picture with that area outlined by a bright line; what is inside the line is shown as it is. The model will get the picture with that area blurred out and must redraw it from your words alone. The user's message gives the line's colour, the action, the words your text must start with, and the user's own words, in any language, or none.
- Start with exactly the given words and write in English, 20 to 60 words in all.
- Remove: name everything inside the line as one thing (the main object with whatever is on it or in it), then, in a second sentence, describe what is seen there instead: the background that continues from just outside the line, with its surface, material, colours, texture or pattern and light, as if the thing had never been there, with no shadow or mark of it left.
- Change: say what inside the line changes and what it becomes, and that the rest of it stays as it is.
- Replace: name what is inside the line and what replaces it, then describe the new thing: what it is, its colours and materials, its size fitting the area and the scene's perspective, light matching the scene and its shadow on the surface under it.
- Add: describe the new thing put inside the line: what it is, its colours and materials, where it stands, its size fitting the scene's perspective, light matching the scene and its shadow.
- Keep everything the user asked for and never contradict it; base every detail on what you see. With no words from the user, choose what fits the scene best.
- Never describe anything outside the line except as what continues into it. Never mention the line, its colour, a mask, a blur or an area.
Output only the instruction."#;

/// Fork: a painted area of a model that inpaints from the words alone (Krea 2, MOSS-Image: plain masked
/// inpainting, no instruction, no guide image): what the area shows after the change, as a description.
pub const PLAIN_AREA_SYSTEM_PROMPT: &str = r#"You write the prompt for an image model that repaints one area of a picture from a description alone. You see the picture with that area outlined by a bright line. The user's message gives the line's colour, the action and the user's own words, in any language, or none.
- Describe only what the area shows after the change, in one English paragraph of 20 to 60 words: for Remove, the background that continues from just outside the line, as if the thing had never been there; for Change, the thing as it looks after the change; for Replace or Add, the new thing, its colours, materials and pose.
- Add the light it gets from the scene and its shadow, in the picture's style.
- Keep everything the user asked for and never contradict it; base every detail on what you see. With no words from the user, choose what fits the scene best.
- Never name anything outside the line, never write what must not be there, and never mention the line, its colour, a mask or an area.
Output only the prompt."#;

/// Built-in system prompt for Expand (outpaint), added 2026-11-04: the enhancer sees the canvas
/// with the new borders still empty and writes what they show; the outpaint instruction
/// (pipeline::effective_prompt) goes in front of it, as for typed words.
pub const EXPAND_SYSTEM_PROMPT: &str = r#"You help an image model extend a picture beyond its borders. You see the picture on a larger canvas whose new border areas are still empty and flat. The user's message says which sides grow and gives the user's own wishes, in any language, or none.
- Write one English paragraph of 30 to 90 words describing what the new areas show so that the whole picture continues naturally past each growing side: what continues there and how it ends at the new edge.
- Keep the same medium, style, light, colours and perspective as the picture. Keep everything the user asked for and put it in the new areas.
- Describe only what the new areas add. Never add new people, animals or main subjects unless the user asks.
- Never mention borders, empty areas, a canvas or extending.
Output only the description."#;

/// The area and Expand texts are short (at most ~90 words).
pub const AREA_MAX_TOKENS: u32 = 256;

/// Prompt+ "Detailed" (2026-11-04, Gabriele: "give more context to the generator"): added after
/// any system prompt, built-in or the user's, it replaces the length asked there. More context
/// only about what is in the picture or what changes, never what is absent or untouched (a list of
/// what stays makes Qwen redraw it; a "no X" puts X in). Not A/B-tested yet.
pub const DETAIL_SCENE: &str = "\n\nDetailed mode: this replaces the length given above. Write 200 to 350 words, up to about 450 when there are several people or many objects. Give the image generator more context about everything that is in the picture: each subject's materials, textures, small details and expression, the setting and the objects in the background, the camera (distance, angle, lens, depth of field), the light and how it falls on each surface, and the colours. Describe only what is there; never write what is absent or what to avoid.";
pub const DETAIL_EDIT: &str = "\n\nDetailed mode: this replaces the length given above. Write 60 to 150 words, up to about 250 for several changes. Give the image editor more context about the change only: the new things' materials, textures and colours, their exact place and size, how the light of the scene falls on them, their shadows and reflections, and how they meet what is around them. Never describe the parts that stay, and never write what must not be added.";
pub const DETAIL_AREA: &str = "\n\nDetailed mode: this replaces the length given above. Write 50 to 120 words, with more context about what is seen inside the line after the edit: materials, textures, colours, light, shadows and how it meets what is around it. Never write what must not be added.";
pub const DETAIL_EXPAND: &str = "\n\nDetailed mode: this replaces the length given above. Write 80 to 180 words, with more context about what the new areas show: materials, textures, colours, the light and how far things are. Never write what is absent.";

/// The longest a Detailed text runs (~450 words; ~1.4 tokens a word).
const DETAIL_MAX_TOKENS: u32 = 1024;

/// A Prompt+ request made "Detailed": its system prompt ends with the length and context of the
/// kind it is (a new image, an edit, a painted area, an expansion), and longer texts are allowed.
pub fn detailed(mut req: TextGenRequest, mode: ResolvedMode) -> TextGenRequest {
    // Fork: by the kind (a model's own area and Expand instructions are not the built-in ones).
    let add = match PromptKind::of(mode) {
        PromptKind::Area => DETAIL_AREA,
        PromptKind::Expand => DETAIL_EXPAND,
        PromptKind::New | PromptKind::Compose => DETAIL_SCENE,
        PromptKind::Edit => DETAIL_EDIT,
    };
    req.system_prompt.push_str(add);
    req.max_tokens = req.max_tokens.max(DETAIL_MAX_TOKENS);
    req
}

/// Longest label kept (a model that rambles is cut, the label is only a hint).
pub const LABEL_MAX_TOKENS: u32 = 96;

/// Longest custom system prompt accepted in Settings (characters).
pub const MAX_SYSTEM_PROMPT_CHARS: usize = 20_000;

/// The built-in prompts ask for up to ~300 words for crowded scenes (~400 tokens); the cap only
/// stops a model that does not end its turn. 512 cut long scene descriptions mid-sentence
/// (2026-10-22); 1024 tokens take ~8 s at the measured ~127 tok/s.
pub const MAX_TOKENS: u32 = 1024;

/// Qwen's recommended sampling for Qwen3-VL (vision-language), used for both prompts.
pub const SAMPLING: TextSampling = TextSampling { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, seed: -1 };

/// Text-to-image, new images from references, edits and combines get the enhancer. Inpaint
/// and outpaint wrap the prompt in their own instructions, and upscales have no prompt.
pub fn applies(mode: ResolvedMode) -> bool {
    matches!(mode, ResolvedMode::Generate | ResolvedMode::Compose | ResolvedMode::Edit | ResolvedMode::MultiReference)
}

/// [`applies`], and inpaints and expansions: coloured marks written as an edit of the marked
/// region (the edit prompt knows marks named by colour), a painted area and an expansion with
/// their own prompts ([`area_request`], [`expand_request`]) inside Kokon's instructions.
pub fn applies_to(mode: ResolvedMode, _marks: bool) -> bool {
    applies(mode) || matches!(mode, ResolvedMode::Inpaint | ResolvedMode::Outpaint)
}

/// What the user's words were, for the area and Expand prompts.
fn words(prompt: &str) -> String {
    let p = prompt.trim();
    if p.is_empty() { "(none)".into() } else { p.to_string() }
}

/// A painted area (no marks): `image` is the untouched region with the area outlined in `color`.
/// Fork: `plain`: the model inpaints from a description alone (`PLAIN_AREA_SYSTEM_PROMPT`); the instructions
/// are the active model's own when it has them (`prompt_for`).
pub fn area_request(cfg: &AppConfig, action: InpaintAction, color: &str, prompt: &str, image: String, seed: i64, plain: bool) -> TextGenRequest {
    let (act, start) = match action {
        InpaintAction::Remove => ("remove", "Remove"),
        InpaintAction::Edit => ("change", "Change"),
        InpaintAction::Replace => ("replace", "Replace"),
        InpaintAction::Add => ("add", "Add"),
    };
    // The app puts the action's words in front of what the user types: only the rest is theirs.
    let typed = if action == InpaintAction::Edit { prompt.trim().strip_prefix("Change").map(str::trim).unwrap_or(prompt.trim()).to_string() } else { action.subject(prompt) };
    TextGenRequest {
        prompt: if plain {
            format!("Line colour: {color}\nAction: {act}\nThe user's words: {}", words(&typed))
        } else {
            format!("Line colour: {color}\nAction: {act}\nStart with: {start}\nThe user's words: {}", words(&typed))
        },
        system_prompt: prompt_for(cfg, PromptKind::Area, plain),
        images: vec![image],
        max_tokens: AREA_MAX_TOKENS,
        sampling: TextSampling { seed, ..SAMPLING },
        stream: true,
    }
}

/// An expansion: `image` is the canvas with the new areas empty; `sides` names them ("left and top").
pub fn expand_request(cfg: &AppConfig, sides: &str, prompt: &str, image: String, seed: i64) -> TextGenRequest {
    TextGenRequest {
        prompt: format!("Growing sides: {sides}\nThe user's wishes: {}", words(prompt)),
        system_prompt: prompt_for(cfg, PromptKind::Expand, false),
        images: vec![image],
        max_tokens: AREA_MAX_TOKENS,
        sampling: TextSampling { seed, ..SAMPLING },
        stream: true,
    }
}

/// The system prompt for `mode`: the one saved in Settings, or the built-in one. Fork: the active
/// model's own first ([`AppConfig::enhancer_model_prompts`], [`model_prompt`]), for every kind.
pub fn system_prompt(cfg: &AppConfig, mode: ResolvedMode) -> String {
    prompt_for(cfg, PromptKind::of(mode), false)
}

/// The `text_gen` request for a job: its seed (so the same seed writes the same prompt, and
/// Regenerate writes a new one) and, for edits and compositions, the references as the image
/// model gets them. `vision`: the text encoder can see images in the engine
/// (`RecommendedSettings::prompt_vision`); without it edits are rewritten from the words alone.
pub fn request(cfg: &AppConfig, mode: ResolvedMode, prompt: &str, images: Vec<String>, seed: i64, vision: bool) -> TextGenRequest {
    let blind_edit = !vision && mode != ResolvedMode::Generate;
    TextGenRequest {
        prompt: prompt.trim().to_string(),
        // The user's own edit instructions (Settings) still win; the built-in ones need the images.
        // Fork: and the model's own edit instructions.
        system_prompt: if blind_edit && cfg.enhancer_edit_prompt.trim().is_empty() && own_prompt(cfg, PromptKind::Edit).is_none() {
            EDIT_BLIND_SYSTEM_PROMPT.into()
        } else {
            system_prompt(cfg, mode)
        },
        images: if mode == ResolvedMode::Generate || !vision { Vec::new() } else { images },
        max_tokens: MAX_TOKENS,
        sampling: TextSampling { seed, ..SAMPLING },
        stream: true,
    }
}

/// Step 1 of a composition: the label request for one reference (as the image model gets it),
/// with the user's request.
pub fn label_request(image: String, request: &str, seed: i64) -> TextGenRequest {
    TextGenRequest {
        prompt: format!("The user's request for the new picture: {}\nLabel what it takes from this image.", request.trim()),
        system_prompt: COMPOSE_LABEL_PROMPT.into(),
        images: vec![image],
        max_tokens: LABEL_MAX_TOKENS,
        sampling: TextSampling { seed, ..SAMPLING },
        stream: true,
    }
}

/// A label as the model wrote it, on one line and without a closing full stop.
pub fn clean_label(text: &str) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    one_line.trim().trim_end_matches('.').trim().chars().take(400).collect()
}

/// Step 2 of a composition: the request with the references' labels, without the images.
pub fn compose_request(cfg: &AppConfig, labels: &[String], prompt: &str, seed: i64) -> TextGenRequest {
    let refs: Vec<String> = labels.iter().enumerate().map(|(i, l)| format!("<image{}>: {l}", i + 1)).collect();
    TextGenRequest {
        prompt: format!("References:\n{}\n\nRequest: {}", refs.join("\n"), prompt.trim()),
        system_prompt: system_prompt(cfg, ResolvedMode::Compose),
        images: Vec::new(),
        max_tokens: MAX_TOKENS,
        sampling: TextSampling { seed, ..SAMPLING },
        stream: true,
    }
}

/// The model's answer as a prompt: trimmed, without a "Prompt:" label or quotes around the
/// whole text. None when nothing usable is left.
pub fn clean(text: &str) -> Option<String> {
    let mut t = text.trim();
    // Fork: a JSON answer in a code fence (Fibo's captions).
    if let Some(body) = t.strip_prefix("```") {
        let body = body.split_once('\n').map(|(_, rest)| rest).unwrap_or("");
        t = body.trim_end().strip_suffix("```").unwrap_or(body).trim();
    }
    for label in ["Prompt:", "Instruction:", "Editing instruction:", "Description:"] {
        if t.get(..label.len()).is_some_and(|head| head.eq_ignore_ascii_case(label)) {
            t = t[label.len()..].trim_start();
        }
    }
    // Quotes around everything, but not quoted text inside (text to render in the image).
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') && !t[1..t.len() - 1].contains('"') {
        t = t[1..t.len() - 1].trim();
    }
    (!t.is_empty()).then(|| t.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_and_prompts() {
        assert!(applies(ResolvedMode::Generate) && applies(ResolvedMode::Edit) && applies(ResolvedMode::MultiReference) && applies(ResolvedMode::Compose));
        assert!(!applies(ResolvedMode::Inpaint) && !applies(ResolvedMode::Outpaint) && !applies(ResolvedMode::Upscale));
        // A painted area and Expand have prompts of their own; an upscale has no prompt.
        assert!(applies_to(ResolvedMode::Inpaint, false) && applies_to(ResolvedMode::Outpaint, false) && !applies_to(ResolvedMode::Upscale, false));
        let mut cfg = AppConfig::default();
        assert_eq!(system_prompt(&cfg, ResolvedMode::Generate), T2I_SYSTEM_PROMPT);
        assert_eq!(system_prompt(&cfg, ResolvedMode::Edit), EDIT_SYSTEM_PROMPT);
        assert_eq!(system_prompt(&cfg, ResolvedMode::MultiReference), EDIT_SYSTEM_PROMPT);
        assert_eq!(system_prompt(&cfg, ResolvedMode::Compose), COMPOSE_SYSTEM_PROMPT);
        cfg.enhancer_edit_prompt = "  Jewelry retouch rules.\n".into();
        cfg.enhancer_t2i_prompt = " \n ".into();
        assert_eq!(system_prompt(&cfg, ResolvedMode::Edit), "Jewelry retouch rules.");
        assert_eq!(system_prompt(&cfg, ResolvedMode::Generate), T2I_SYSTEM_PROMPT, "blank = built-in");
        assert_eq!(system_prompt(&cfg, ResolvedMode::Compose), COMPOSE_SYSTEM_PROMPT, "an edit prompt does not change compose");
        cfg.enhancer_compose_prompt = "Product shots only.".into();
        assert_eq!(system_prompt(&cfg, ResolvedMode::Compose), "Product shots only.");
        assert!(T2I_SYSTEM_PROMPT.ends_with("Output only the prompt.") && EDIT_SYSTEM_PROMPT.contains("<image1>, <image2>"));
    }

    #[test]
    fn builtin_prompts_have_nothing_the_model_copies() {
        // Seen in real outputs (bench sysprompt-v2-20261019-155557): example colours ended up in
        // almost every prompt, and the text rule became "No text appears in the image."
        for p in [T2I_SYSTEM_PROMPT, EDIT_SYSTEM_PROMPT, COMPOSE_SYSTEM_PROMPT, COMPOSE_LABEL_PROMPT, AREA_SYSTEM_PROMPT, EXPAND_SYSTEM_PROMPT] {
            for leak in ["deep navy", "pale cream", "copper", "No text"] {
                assert!(!p.contains(leak), "{leak:?} in a built-in prompt");
            }
        }
        assert!(T2I_SYSTEM_PROMPT.contains("Otherwise write nothing about text."));
        // The layers lab's New objects: the user names marks by colour; Prompt+ places things there.
        assert!(EDIT_SYSTEM_PROMPT.contains("Coloured marks drawn by hand"));
    }

    #[test]
    fn request_uses_job_seed_and_images_only_for_edits() {
        let cfg = AppConfig::default();
        let r = request(&cfg, ResolvedMode::Edit, " rendi la macchina nera ", vec!["PNG".into()], 1234, true);
        assert_eq!((r.prompt.as_str(), r.images.len(), r.sampling.seed, r.max_tokens), ("rendi la macchina nera", 1, 1234, MAX_TOKENS));
        assert_eq!((r.sampling.temperature, r.sampling.top_p, r.sampling.top_k, r.sampling.presence_penalty), (0.7, 0.8, 20, 1.5));
        assert!(r.stream);
        let r = request(&cfg, ResolvedMode::Generate, "un gatto", vec!["PNG".into()], 1, true);
        assert!(r.images.is_empty() && r.system_prompt == T2I_SYSTEM_PROMPT);
        // Compose: each reference labelled alone, then the scene from the labels, without images.
        let l = label_request("A".into(), " la ciotola su un tavolo ", 5);
        assert_eq!((l.images.len(), l.system_prompt.as_str(), l.sampling.seed, l.max_tokens), (1, COMPOSE_LABEL_PROMPT, 5, LABEL_MAX_TOKENS));
        assert!(l.prompt.contains("la ciotola su un tavolo\n"), "the label knows what the request takes");
        let labels = vec!["person, female, dark hair; style: photo".to_string(), "cat, orange tabby; style: photo".to_string()];
        let r = compose_request(&cfg, &labels, " lei sul divano con il gatto ", 5);
        assert!(r.images.is_empty() && r.system_prompt == COMPOSE_SYSTEM_PROMPT && r.sampling.seed == 5);
        assert_eq!(r.prompt, "References:\n<image1>: person, female, dark hair; style: photo\n<image2>: cat, orange tabby; style: photo\n\nRequest: lei sul divano con il gatto");
        assert_eq!(clean_label(" cat,\n orange tabby.\n"), "cat, orange tabby");
    }

    #[test]
    fn edits_without_vision_are_rewritten_from_the_words() {
        // FLUX.3 / Krea 2: the engine can't show images to their text encoder.
        let mut cfg = AppConfig::default();
        let r = request(&cfg, ResolvedMode::Edit, "make it winter", vec!["PNG".into()], 7, false);
        assert!(r.images.is_empty(), "no images: the engine would refuse the request");
        assert_eq!(r.system_prompt, EDIT_BLIND_SYSTEM_PROMPT);
        assert!(EDIT_BLIND_SYSTEM_PROMPT.contains("you do not see them") && !EDIT_BLIND_SYSTEM_PROMPT.contains("<image1>"));
        let r = request(&cfg, ResolvedMode::MultiReference, "put the cat on the sofa", vec!["A".into(), "B".into()], 7, false);
        assert!(r.images.is_empty() && r.system_prompt == EDIT_BLIND_SYSTEM_PROMPT);
        // New images are the same either way, and the user's own edit instructions still win.
        assert_eq!(request(&cfg, ResolvedMode::Generate, "a cat", vec![], 1, false).system_prompt, T2I_SYSTEM_PROMPT);
        cfg.enhancer_edit_prompt = "My own rules.".into();
        assert_eq!(request(&cfg, ResolvedMode::Edit, "x", vec!["PNG".into()], 1, false).system_prompt, "My own rules.");
    }

    #[test]
    fn each_model_can_have_its_own_instructions_for_each_kind() {
        use crate::config::{ModelPrompts, JUGGERNAUT_MOSS_TURBO, JUGGERNAUT_PROFILE_ID, QWEN_IMAGE_21};
        let mut cfg = AppConfig::default();
        cfg.normalize();
        // Qwen-Image 2.1: the general ones (they were written and A/B-tested for it).
        for (mode, want) in [(ResolvedMode::Generate, T2I_SYSTEM_PROMPT), (ResolvedMode::Edit, EDIT_SYSTEM_PROMPT), (ResolvedMode::Compose, COMPOSE_SYSTEM_PROMPT)] {
            assert_eq!(system_prompt(&cfg, mode), want);
        }
        // Juggernaut Moss Turbo: its built-in ones for new images, painted areas and Expand, even over the
        // user's general ones; edits keep the general ones.
        cfg.enhancer_t2i_prompt = "General.".into();
        cfg.active_profile = JUGGERNAUT_PROFILE_ID.into();
        assert_eq!(system_prompt(&cfg, ResolvedMode::Generate), JUGGERNAUT_T2I_PROMPT);
        assert_eq!(prompt_for(&cfg, PromptKind::Area, true), JUGGERNAUT_AREA_PROMPT);
        assert_eq!(expand_request(&cfg, "left", "", "P".into(), 1).system_prompt, JUGGERNAUT_EXPAND_PROMPT);
        assert_eq!(system_prompt(&cfg, ResolvedMode::Edit), EDIT_SYSTEM_PROMPT);
        for p in [JUGGERNAUT_T2I_PROMPT, JUGGERNAUT_AREA_PROMPT, JUGGERNAUT_EXPAND_PROMPT, FLUX3_T2I_PROMPT, KREA2_T2I_PROMPT, FIBO2_T2I_PROMPT, MOSS_T2I_PROMPT, PLAIN_AREA_SYSTEM_PROMPT] {
            let end = p.trim_end();
            assert!(p.chars().count() < MAX_SYSTEM_PROMPT_CHARS && (end.ends_with("Output only the prompt.") || end.ends_with("Output only the JSON object.")));
        }
        // The other models' own instructions for new images, from their makers' guides.
        for (model, want) in [
            (crate::config::FLUX3_KLEIN, FLUX3_T2I_PROMPT),
            (crate::config::KREA2_TURBO, KREA2_T2I_PROMPT),
            (crate::config::FIBO2_DEV, FIBO2_T2I_PROMPT),
            (crate::config::FIBO2_EDIT, FIBO2_T2I_PROMPT),
            (crate::config::MOSS_IMAGE_SFT, MOSS_T2I_PROMPT),
        ] {
            assert_eq!(model_prompt(model, PromptKind::New), Some(want), "{model}");
        }
        assert!(model_prompt(QWEN_IMAGE_21, PromptKind::New).is_none());
        // The user's own for this model win, kind by kind.
        cfg.enhancer_model_prompts.insert(JUGGERNAUT_MOSS_TURBO.into(), ModelPrompts { new: " Mine. ".into(), expand: "Wider.".into(), ..Default::default() });
        assert_eq!(system_prompt(&cfg, ResolvedMode::Generate), "Mine.");
        assert_eq!(system_prompt(&cfg, ResolvedMode::Outpaint), "Wider.");
        assert_eq!(system_prompt(&cfg, ResolvedMode::Inpaint), JUGGERNAUT_AREA_PROMPT);
        // A blind edit with the model's own edit instructions uses them.
        cfg.enhancer_model_prompts.get_mut(JUGGERNAUT_MOSS_TURBO).unwrap().edit = "Edit like this.".into();
        assert_eq!(request(&cfg, ResolvedMode::Edit, "x", vec!["P".into()], 1, false).system_prompt, "Edit like this.");
        // Saved: only text that differs from the built-in one.
        cfg.enhancer_model_prompts.insert(QWEN_IMAGE_21.into(), ModelPrompts { new: T2I_SYSTEM_PROMPT.into(), area: " ".into(), ..Default::default() });
        cfg.normalize();
        assert_eq!(cfg.enhancer_model_prompts.keys().collect::<Vec<_>>(), [JUGGERNAUT_MOSS_TURBO]);
        cfg.enhancer_model_prompts.insert(JUGGERNAUT_MOSS_TURBO.into(), ModelPrompts { new: format!("{JUGGERNAUT_T2I_PROMPT}\n"), ..Default::default() });
        cfg.normalize();
        assert!(cfg.enhancer_model_prompts.is_empty());
        cfg.enhancer_model_prompts.insert("x".into(), ModelPrompts { compose: "x".repeat(MAX_SYSTEM_PROMPT_CHARS + 1), ..Default::default() });
        assert!(cfg.validate().is_err());
        // 0.12.1036 saved one string per model: its instructions for new images.
        let old: std::collections::BTreeMap<String, ModelPrompts> = serde_json::from_str(r#"{"a": "Old.", "b": {"area": "Here."}}"#).unwrap();
        assert_eq!((old["a"].new.as_str(), old["b"].area.as_str(), old["b"].new.as_str()), ("Old.", "Here.", ""));
    }

    #[test]
    fn json_answers_lose_their_code_fence() {
        assert_eq!(clean("```json\n{\"short_description\": \"a cat\"}\n```").as_deref(), Some("{\"short_description\": \"a cat\"}"));
        assert_eq!(clean("{\"a\": 1}").as_deref(), Some("{\"a\": 1}"));
    }

    #[test]
    fn detailed_asks_for_more_context_of_its_kind() {
        let cfg = AppConfig::default();
        let t = detailed(request(&cfg, ResolvedMode::Generate, "un gatto", vec![], 1, true), ResolvedMode::Generate);
        assert!(t.system_prompt.starts_with(T2I_SYSTEM_PROMPT) && t.system_prompt.ends_with(DETAIL_SCENE));
        let e = detailed(request(&cfg, ResolvedMode::Edit, "x", vec!["P".into()], 1, true), ResolvedMode::Edit);
        assert!(e.system_prompt.ends_with(DETAIL_EDIT));
        let a = detailed(area_request(&cfg, InpaintAction::Remove, "cyan", "", "P".into(), 1, false), ResolvedMode::Inpaint);
        assert!(a.system_prompt.ends_with(DETAIL_AREA) && a.max_tokens == DETAIL_MAX_TOKENS);
        let x = detailed(expand_request(&cfg, "left", "", "P".into(), 1), ResolvedMode::Outpaint);
        assert!(x.system_prompt.ends_with(DETAIL_EXPAND));
        // Only what is there: no "keep" lists, no "no X".
        for d in [DETAIL_SCENE, DETAIL_EDIT, DETAIL_AREA, DETAIL_EXPAND] {
            assert!(d.contains("replaces the length") && !d.contains("unchanged"));
        }
        assert!(450.0 * 1.4 < DETAIL_MAX_TOKENS as f64);
    }

    #[test]
    fn area_and_expand_requests() {
        let cfg = AppConfig::default();
        let r = area_request(&cfg, InpaintAction::Remove, "magenta", "  ", "PNG".into(), 7, false);
        assert_eq!(r.prompt, "Line colour: magenta\nAction: remove\nStart with: Remove\nThe user's words: (none)");
        // The action's words the app puts in front are not the user's.
        assert!(area_request(&cfg, InpaintAction::Remove, "magenta", "Remove ", "PNG".into(), 7, false).prompt.ends_with("(none)"));
        assert!(area_request(&cfg, InpaintAction::Remove, "magenta", "Remove the lamp", "PNG".into(), 7, false).prompt.ends_with("words: the lamp"));
        assert_eq!((r.images.len(), r.system_prompt.as_str(), r.sampling.seed, r.max_tokens), (1, AREA_SYSTEM_PROMPT, 7, AREA_MAX_TOKENS));
        let r = area_request(&cfg, InpaintAction::Add, "cyan", " un vaso di fiori ", "PNG".into(), 1, false);
        assert!(r.prompt.ends_with("Action: add\nStart with: Add\nThe user's words: un vaso di fiori"));
        // Fork: a model that inpaints from words alone gets a description, with no words to start with.
        let p = area_request(&cfg, InpaintAction::Remove, "cyan", "Remove the lamp", "PNG".into(), 1, true);
        assert_eq!((p.prompt.as_str(), p.system_prompt.as_str()), ("Line colour: cyan\nAction: remove\nThe user's words: the lamp", PLAIN_AREA_SYSTEM_PROMPT));
        let r = expand_request(&cfg, "left and right", "", "PNG".into(), 3);
        assert_eq!(r.prompt, "Growing sides: left and right\nThe user's wishes: (none)");
        assert!(r.system_prompt == EXPAND_SYSTEM_PROMPT && r.images.len() == 1);
        // The instruction around it is Kokon's: the text is only what goes in the area.
        assert!(AREA_SYSTEM_PROMPT.contains("Never mention the line") && EXPAND_SYSTEM_PROMPT.contains("Never mention borders"));
    }

    #[test]
    fn compose_prompt_makes_a_new_picture() {
        // "Keep everything else unchanged" turns a composition into an edit of image 1.
        assert!(!COMPOSE_SYSTEM_PROMPT.contains("unchanged"));
        assert!(COMPOSE_SYSTEM_PROMPT.contains("<image1>, <image2>") && COMPOSE_SYSTEM_PROMPT.contains("new image"));
        assert!(!COMPOSE_LABEL_PROMPT.contains("unchanged"));
        // Long scenes are allowed for, within the token cap (~1.4 tokens a word at most).
        assert!(COMPOSE_SYSTEM_PROMPT.contains("280") && T2I_SYSTEM_PROMPT.contains("250"));
        assert!(300.0 * 1.4 < MAX_TOKENS as f64);
    }

    #[test]
    fn cleaning() {
        assert_eq!(clean("  A watercolour fox.\n").as_deref(), Some("A watercolour fox."));
        assert_eq!(clean("Prompt: A fox.").as_deref(), Some("A fox."));
        assert_eq!(clean("\"A fox in snow.\"").as_deref(), Some("A fox in snow."));
        let sign = "A shop sign reading \"CAFÉ\" above the door, lit by \"warm\" lamps.";
        assert_eq!(clean(sign).as_deref(), Some(sign), "inner quotes are text to render");
        assert_eq!(clean("\"OPEN\" glows in red neon above a \"BAR\"").as_deref(), Some("\"OPEN\" glows in red neon above a \"BAR\""));
        assert_eq!(clean(" \n "), None);
        assert_eq!(clean("Prompt:"), None);
        assert_eq!(clean("Ünïcode first").as_deref(), Some("Ünïcode first"), "no slicing inside a character");
    }
}
