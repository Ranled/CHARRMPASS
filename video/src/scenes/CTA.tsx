import React from 'react';
import {AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {Background, Logo} from '../components';
import {SFX} from '../Audio';
import {C, FONT} from '../theme';

export const DUR = 210;

export const CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const logo = spring({frame, fps, config: {damping: 10, stiffness: 100}});
  const tag = interpolate(frame, [30, 55], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const btn = spring({frame: frame - 70, fps, config: {damping: 8}});
  const pulse = 1 + Math.sin(frame / 8) * 0.03 * (frame > 90 ? 1 : 0);
  const fadeIn = interpolate(frame, [0, 10], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{opacity: fadeIn}}>
      <Background hue={6} />
      <SFX file="whoosh" at={0} />
      <SFX file="pop" at={70} />
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', fontFamily: FONT}}>
        <div style={{transform: `scale(${logo}) rotate(${(1 - logo) * -20}deg)`, opacity: logo}}>
          <Logo size={340} />
        </div>
        <div style={{fontSize: 110, fontWeight: 900, letterSpacing: -3, opacity: tag, transform: `translateY(${(1 - tag) * 30}px)`}}>
          CHARRM<span style={{color: C.yellow}}>PASS</span>
        </div>
        <div style={{fontSize: 40, color: C.light, opacity: tag, marginTop: 6}}>
          Smart parking. Real-time control. One tap.
        </div>
        <div
          style={{
            marginTop: 50, background: C.yellow, color: C.deep, fontSize: 44, fontWeight: 800,
            padding: '24px 70px', borderRadius: 999, opacity: btn,
            transform: `scale(${btn * pulse})`, boxShadow: '0 0 60px rgba(245,179,53,0.5)',
          }}
        >
          Get Started Today →
        </div>
        <div style={{marginTop: 24, fontSize: 30, opacity: btn * 0.8, color: C.white}}>charrmpass.vercel.app</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
