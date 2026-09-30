import {Easing, interpolate} from 'remotion';

// Every image scene shows the FULL, uncropped screenshot first (progress 0),
// then eases into a focal push-in for the back half of the scene (progress 1).
export const computeRevealProgress = (
  frame: number,
  durationInFrames: number,
) => {
  const holdStart = Math.round(durationInFrames * 0.22);
  const holdEnd = Math.round(durationInFrames * 0.16);
  const transitionStart = holdStart;
  const transitionEnd = Math.max(
    transitionStart + 1,
    durationInFrames - holdEnd,
  );

  return interpolate(frame, [transitionStart, transitionEnd], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.ease),
  });
};
