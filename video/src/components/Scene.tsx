import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import type {ImageScene} from '../narration';
import {computeRevealProgress} from '../sceneMotion';
import {KenBurnsImage} from './KenBurnsImage';
import {Kicker} from './Kicker';
import {Subtitle} from './Subtitle';

export const Scene: React.FC<{scene: ImageScene}> = ({scene}) => {
  const frame = useCurrentFrame();
  const p = computeRevealProgress(frame, scene.durationInFrames);

  // While the full screenshot is showing there's nothing to scrim against —
  // the gradient only fades in once the push-in starts covering the frame.
  const scrimOpacity = interpolate(p, [0, 0.5], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill>
      <KenBurnsImage
        src={scene.image}
        natural={scene.natural}
        focal={scene.focal}
        durationInFrames={scene.durationInFrames}
        zoomExtra={scene.zoomExtra}
      />
      <AbsoluteFill
        style={{
          opacity: scrimOpacity,
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.32) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 60%, rgba(0,0,0,0.5) 100%)',
        }}
      />
      <Kicker text={scene.kicker} />
      <Subtitle text={scene.caption} />
    </AbsoluteFill>
  );
};
