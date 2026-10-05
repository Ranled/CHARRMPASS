import React from 'react';
import {AbsoluteFill, Composition, Sequence} from 'remotion';
import {Hook, DUR as D1} from './scenes/Hook';
import {Solution, DUR as D2} from './scenes/Solution';
import {Metrics, DUR as D3} from './scenes/Metrics';
import {CTA, DUR as D4} from './scenes/CTA';
import {Music} from './Audio';
import {C} from './theme';

const MarketingVideo: React.FC = () => (
  <AbsoluteFill style={{backgroundColor: C.bg}}>
    <Music />
    <Sequence from={0} durationInFrames={D1}><Hook /></Sequence>
    <Sequence from={D1} durationInFrames={D2}><Solution /></Sequence>
    <Sequence from={D1 + D2} durationInFrames={D3}><Metrics /></Sequence>
    <Sequence from={D1 + D2 + D3} durationInFrames={D4}><CTA /></Sequence>
  </AbsoluteFill>
);

export const Root: React.FC = () => (
  <Composition
    id="Root"
    component={MarketingVideo}
    durationInFrames={D1 + D2 + D3 + D4}
    fps={30}
    width={1920}
    height={1080}
  />
);
