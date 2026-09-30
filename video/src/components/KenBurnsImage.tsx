import React from 'react';
import {AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame} from 'remotion';
import type {Focal} from '../narration';
import {computeRevealProgress} from '../sceneMotion';
import {theme} from '../theme';

const axisPosition = (
  canvasDim: number,
  imgDim: number,
  scale: number,
  originFrac: number,
) => {
  const size = imgDim * scale;
  if (size <= canvasDim) {
    // Image fits within the canvas on this axis — center it (letterbox).
    return (canvasDim - size) / 2;
  }
  // Image overflows this axis — pan toward the origin, clamped so we never
  // reveal empty space at the edges.
  const raw = canvasDim / 2 - originFrac * size;
  return Math.min(0, Math.max(canvasDim - size, raw));
};

export const KenBurnsImage: React.FC<{
  src: string;
  natural: {w: number; h: number};
  focal: Focal;
  durationInFrames: number;
  zoomExtra?: number;
  canvasSize?: number;
}> = ({src, natural, focal, durationInFrames, zoomExtra = 1.12, canvasSize = 1080}) => {
  const frame = useCurrentFrame();
  const p = computeRevealProgress(frame, durationInFrames);

  const containScale = Math.min(canvasSize / natural.w, canvasSize / natural.h);
  const coverScale = Math.max(canvasSize / natural.w, canvasSize / natural.h) * zoomExtra;

  const scale = interpolate(p, [0, 1], [containScale, coverScale]);
  const ox = interpolate(p, [0, 1], [0.5, focal.x]);
  const oy = interpolate(p, [0, 1], [0.5, focal.y]);

  const left = axisPosition(canvasSize, natural.w, scale, ox);
  const top = axisPosition(canvasSize, natural.h, scale, oy);

  // The rounded-card treatment only reads while the full frame is visible;
  // it fades out as the image grows past the canvas edges during the push-in.
  const cardStrength = interpolate(p, [0, 0.4], [1, 0], {
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{backgroundColor: theme.bg, overflow: 'hidden'}}>
      <Img
        src={staticFile(`assets/${src}`)}
        style={{
          position: 'absolute',
          left,
          top,
          width: natural.w,
          height: natural.h,
          transform: `scale(${scale})`,
          transformOrigin: '0 0',
          borderRadius: 18 * cardStrength,
          boxShadow: `0 ${30 * cardStrength}px ${70 * cardStrength}px rgba(20,16,10,${
            0.28 * cardStrength
          })`,
          border: `${1 * cardStrength}px solid rgba(27,24,18,${0.1 * cardStrength})`,
        }}
      />
    </AbsoluteFill>
  );
};
