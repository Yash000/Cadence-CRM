import React from 'react';
import {Composition} from 'remotion';
import {CadenceWalkthrough} from './Video';
import {totalDurationInFrames} from './narration';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="CadenceWalkthrough"
      component={CadenceWalkthrough}
      durationInFrames={totalDurationInFrames}
      fps={30}
      width={1080}
      height={1080}
    />
  );
};
