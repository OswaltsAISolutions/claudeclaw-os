import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
// WSL headless chrome: no sandbox user namespaces by default.
Config.setChromiumOpenGlRenderer('angle-egl');
