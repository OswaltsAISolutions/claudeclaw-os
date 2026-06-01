JARVIS Home boot-sequence audio assets.

Vite copies anything in web/public/ to the build output root at build
time. The JARVIS Home boot sequence loads background music from this
directory at runtime:

  /sounds/jarvis-boot.mp3   (referenced by web/src/pages/JarvisHome.tsx)

Drop your AC/DC clip (or any boot-music track) at that exact path.
~12-15 seconds is the sweet spot — the boot sequence is timed to that
length and fades the music in over 3 seconds and out over 1.5 seconds.

If the file is missing the boot still plays — just silent on the music
channel. Voice narration via ElevenLabs is independent of this file.
