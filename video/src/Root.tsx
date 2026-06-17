import { Composition } from 'remotion';
import { CaptionedClip, type CaptionedClipProps } from './CaptionedClip';
import { Timeline, TIMELINE_DIMENSIONS, type TimelinePlan } from './Timeline';

const FPS = 30;

const defaultPlan: TimelinePlan = {
  aspect: '9:16',
  durationS: 10,
  video: [],
  overlays: [],
  audio: [],
  captions: null,
};

const defaultProps: CaptionedClipProps = {
  videoSrc: 'test.mp4',
  durationS: 10,
  aspect: '9:16',
  words: [],
  accent: '#FFD400',
};

export function Root() {
  return (
    <>
    <Composition
      id="CaptionedClip"
      component={CaptionedClip}
      fps={FPS}
      width={1080}
      height={1920}
      durationInFrames={300}
      defaultProps={defaultProps}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(1, Math.ceil(props.durationS * FPS)),
        width: props.aspect === '16:9' ? 1920 : 1080,
        height: props.aspect === '16:9' ? 1080 : 1920,
      })}
    />
    <Composition
      id="Timeline"
      component={Timeline}
      fps={FPS}
      width={1080}
      height={1920}
      durationInFrames={300}
      defaultProps={{ plan: defaultPlan }}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(1, Math.ceil(props.plan.durationS * FPS)),
        ...TIMELINE_DIMENSIONS[props.plan.aspect],
      })}
    />
    </>
  );
}
