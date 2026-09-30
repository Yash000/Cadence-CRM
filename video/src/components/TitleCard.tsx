import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import type {TitleScene} from '../narration';
import {fontStack, theme} from '../theme';

export const TitleCard: React.FC<{scene: TitleScene}> = ({scene}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const enter = spring({frame, fps, config: {damping: 200, mass: 0.8}});
  const opacity = interpolate(enter, [0, 1], [0, 1]);
  const y = interpolate(enter, [0, 1], [22, 0]);
  const ruleWidth = interpolate(enter, [0, 1], [0, 120]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: theme.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{opacity, transform: `translateY(${y}px)`, textAlign: 'center'}}>
        {scene.eyebrow ? (
          <div
            style={{
              fontFamily: fontStack,
              fontSize: 28,
              fontWeight: 600,
              letterSpacing: 1,
              color: theme.muted,
              marginBottom: 18,
              textTransform: 'uppercase',
            }}
          >
            {scene.eyebrow}
          </div>
        ) : null}
        <div
          style={{
            fontFamily: fontStack,
            fontSize: 128,
            fontWeight: 800,
            letterSpacing: -3,
            color: theme.ink,
            lineHeight: 1,
          }}
        >
          {scene.heading}
        </div>
        <div
          style={{
            width: ruleWidth,
            height: 4,
            background: theme.ink,
            opacity: 0.85,
            margin: '30px auto',
            borderRadius: 2,
          }}
        />
        <div
          style={{
            fontFamily: fontStack,
            fontSize: 32,
            fontWeight: 500,
            color: theme.muted,
            maxWidth: 780,
          }}
        >
          {scene.sub}
        </div>
      </div>
    </AbsoluteFill>
  );
};
