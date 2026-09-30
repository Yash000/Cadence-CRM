import React from 'react';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {fontStack, theme} from '../theme';

export const Kicker: React.FC<{text: string}> = ({text}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const enter = spring({frame, fps, config: {damping: 200, mass: 0.6}});
  const opacity = interpolate(enter, [0, 1], [0, 1]);
  const x = interpolate(enter, [0, 1], [-24, 0]);

  return (
    <div
      style={{
        position: 'absolute',
        top: 56,
        left: 56,
        opacity,
        transform: `translateX(${x}px)`,
      }}
    >
      <div
        style={{
          fontFamily: fontStack,
          fontSize: 26,
          fontWeight: 600,
          letterSpacing: 0.2,
          color: theme.kickerText,
          background: theme.kickerBg,
          padding: '10px 22px',
          borderRadius: 999,
        }}
      >
        {text}
      </div>
    </div>
  );
};
