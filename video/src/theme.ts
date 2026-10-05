import {CSSProperties} from 'react';

// Palette taken from the main system's styles.css
export const C = {
  dark: '#0E5C4A',
  deep: '#072b22',
  mid: '#147a63',
  light: '#B7D8B0',
  yellow: '#F5B335',
  white: '#FFFFFF',
  gray: '#F8FAFC',
  slate: '#64748B',
  text: '#1F2937',
  red: '#EF4444',
  green: '#22C55E',
  bg: '#051411',
};

export const FONT = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";

export const fill: CSSProperties = {
  position: 'absolute',
  inset: 0,
  fontFamily: FONT,
  color: C.white,
};

export const glass: CSSProperties = {
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 28,
  backdropFilter: 'blur(14px)',
  boxShadow: '0 30px 80px rgba(0,0,0,0.35)',
};

export const FPS = 30;
