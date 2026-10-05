import React from 'react';
import {Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {C, FONT, fill} from './theme';

export const Background: React.FC<{hue?: number}> = ({hue = 0}) => {
  const frame = useCurrentFrame();
  const x = 50 + Math.sin(frame / 60 + hue) * 20;
  const y = 40 + Math.cos(frame / 75 + hue) * 20;
  return (
    <div
      style={{
        ...fill,
        background: `radial-gradient(circle at ${x}% ${y}%, ${C.mid} 0%, ${C.dark} 28%, ${C.deep} 62%, ${C.bg} 100%)`,
      }}
    />
  );
};

/** Word-by-word kinetic typography with spring entrance. */
export const KineticText: React.FC<{
  text: string;
  delay?: number;
  size?: number;
  color?: string;
  highlight?: string[];
  stagger?: number;
}> = ({text, delay = 0, size = 120, color = C.white, highlight = [], stagger = 5}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return (
    <div style={{display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: size * 0.25, fontFamily: FONT}}>
      {text.split(' ').map((w, i) => {
        const s = spring({frame: frame - delay - i * stagger, fps, config: {damping: 12, stiffness: 120}});
        const hl = highlight.includes(w.replace(/[^\w]/g, ''));
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              fontSize: size,
              fontWeight: 900,
              letterSpacing: -2,
              color: hl ? C.yellow : color,
              opacity: s,
              transform: `translateY(${(1 - s) * 80}px) scale(${0.7 + 0.3 * s})`,
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

export const Floating: React.FC<{
  children: React.ReactNode;
  delay?: number;
  phase?: number;
  style?: React.CSSProperties;
}> = ({children, delay = 0, phase = 0, style}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s = spring({frame: frame - delay, fps, config: {damping: 14, stiffness: 90}});
  const float = Math.sin(frame / 25 + phase) * 10;
  return (
    <div style={{opacity: s, transform: `translateY(${(1 - s) * 120 + float}px) scale(${0.85 + 0.15 * s})`, ...style}}>
      {children}
    </div>
  );
};

export const Logo: React.FC<{size: number}> = ({size}) => (
  <Img src={staticFile('logo.png')} style={{width: size, height: size, objectFit: 'contain'}} />
);

export const fadeInOut = (frame: number, dur: number, edge = 10) =>
  interpolate(frame, [0, edge, dur - edge, dur], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
