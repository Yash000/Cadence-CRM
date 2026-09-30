import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {fontStack, theme} from '../theme';

export const Subtitle: React.FC<{text: string}> = ({text}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const enter = spring({
    frame: frame - 4,
    fps,
    config: {damping: 200, mass: 0.7},
  });
  const opacity = interpolate(enter, [0, 1], [0, 1], {
    extrapolateLeft: 'clamp',
  });
  const y = interpolate(enter, [0, 1], [16, 0], {extrapolateLeft: 'clamp'});

  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-end',
        alignItems: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          marginBottom: 64,
          maxWidth: 900,
          padding: '20px 34px',
          borderRadius: 20,
          background: theme.subtitleBg,
          opacity,
          transform: `translateY(${y}px)`,
        }}
      >
        <div
          style={{
            fontFamily: fontStack,
            fontSize: 34,
            lineHeight: 1.32,
            fontWeight: 600,
            color: theme.subtitleText,
            textAlign: 'center',
          }}
        >
          {text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
