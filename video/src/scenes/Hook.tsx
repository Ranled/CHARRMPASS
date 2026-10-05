import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {Background, KineticText, fadeInOut} from '../components';
import {SFX} from '../Audio';
import {C, FONT} from '../theme';

export const DUR = 150;

export const Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const sub = interpolate(frame, [60, 85], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const shake = frame > 40 && frame < 48 ? Math.sin(frame * 3) * 6 : 0;
  return (
    <AbsoluteFill style={{opacity: fadeInOut(frame, DUR)}}>
      <Background />
      <SFX file="whoosh" at={0} />
      <SFX file="pop" at={60} />
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', padding: 120, transform: `translateX(${shake}px)`}}>
        <KineticText text="Campus parking is chaos." size={140} highlight={['chaos']} />
        <div style={{height: 50}} />
        <div
          style={{
            fontFamily: FONT,
            fontSize: 52,
            color: C.light,
            opacity: sub,
            transform: `translateY(${(1 - sub) * 30}px)`,
            textAlign: 'center',
            fontWeight: 500,
          }}
        >
          Paper logs. Unverified vehicles. No real-time visibility.
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
