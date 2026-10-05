import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {Background, KineticText, fadeInOut} from '../components';
import {SFX} from '../Audio';
import {C, FONT, glass} from '../theme';

export const DUR = 240;

const Stat: React.FC<{to: number; prefix?: string; suffix: string; label: string; delay: number; decimals?: number}> = ({
  to, prefix = '', suffix, label, delay, decimals = 0,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - delay, fps, config: {damping: 14}});
  const v = interpolate(frame, [delay, delay + 60], [0, to], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <div style={{...glass, width: 480, padding: '60px 30px', textAlign: 'center', fontFamily: FONT, opacity: s, transform: `scale(${0.7 + 0.3 * s})`}}>
      <div style={{fontSize: 130, fontWeight: 900, color: C.yellow, letterSpacing: -4}}>
        {prefix}{v.toFixed(decimals)}{suffix}
      </div>
      <div style={{fontSize: 34, color: C.light, fontWeight: 600, marginTop: 10}}>{label}</div>
    </div>
  );
};

export const Metrics: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{opacity: fadeInOut(frame, DUR)}}>
      <Background hue={4} />
      <SFX file="whoosh" at={0} />
      <SFX file="pop" at={30} />
      <SFX file="pop" at={60} />
      <SFX file="pop" at={90} />
      <AbsoluteFill style={{alignItems: 'center', paddingTop: 100}}>
        <KineticText text="Fast. Automated. Secure." size={100} highlight={['Automated']} />
      </AbsoluteFill>
      <AbsoluteFill style={{flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 40, paddingTop: 120}}>
        <Stat to={1} prefix="<" suffix="s" label="Gate response per tap" delay={30} />
        <Stat to={100} suffix="%" label="Real-time activity logging" delay={60} />
        <Stat to={24} suffix="/7" label="Automated access control" delay={90} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
