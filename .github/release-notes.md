- **Fix: pausing and resuming the download of an extra model.** Resume after Pause continued the
  Qwen-Image 2.1 files instead of the model being downloaded (FLUX.3, Fibo 2.0, Krea 2 or
  MOSS-Image). Those were already there, so the progress jumped to 100% and the model was forgotten.
  Resume, and Try again after a failed file, now go on with the model you chose. The progress
  panel also names that model.
