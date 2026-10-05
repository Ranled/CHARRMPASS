import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {Background, Floating, KineticText, fadeInOut} from '../components';
import {SFX} from '../Audio';
import {C, FONT, glass} from '../theme';

export const DUR = 300;

const TapFeed: React.FC = () => {
  const frame = useCurrentFrame();
  const rows = [
    {n: 'Juan D.', r: 'Student', t: 'ENTRY', c: C.green},
    {n: 'Prof. Reyes', r: 'Faculty', t: 'ENTRY', c: C.green},
    {n: 'Maria S.', r: 'Staff', t: 'EXIT', c: C.yellow},
    {n: 'Visitor 014', r: 'Visitor', t: 'ENTRY', c: C.green},
  ];
  return (
    <div style={{...glass, width: 760, padding: 36}}>
      <div style={{fontFamily: FONT, fontSize: 30, fontWeight: 800, marginBottom: 24}}>Live Tap Feed</div>
      {rows.map((r, i) => {
        const o = interpolate(frame, [40 + i * 25, 55 + i * 25], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
        return (
          <div
            key={i}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '18px 20px', marginBottom: 12, borderRadius: 16,
              background: 'rgba(255,255,255,0.07)', fontFamily: FONT, opacity: o,
              transform: `translateX(${(1 - o) * 80}px)`,
            }}
          >
            <div>
              <div style={{fontSize: 28, fontWeight: 700}}>{r.n}</div>
              <div style={{fontSize: 20, color: C.light}}>{r.r}</div>
            </div>
            <div style={{background: r.c, color: C.deep, fontWeight: 800, fontSize: 20, padding: '8px 20px', borderRadius: 999}}>
              {r.t}
            </div>
          </div>
        );
      })}
    </div>
  );
};

const Chart: React.FC = () => {
  const frame = useCurrentFrame();
  const bars = [40, 65, 50, 85, 70, 95, 60];
  return (
    <div style={{...glass, width: 620, padding: 36}}>
      <div style={{fontFamily: FONT, fontSize: 30, fontWeight: 800, marginBottom: 24}}>Parking Analytics</div>
      <div style={{display: 'flex', alignItems: 'flex-end', gap: 18, height: 240}}>
        {bars.map((b, i) => {
          const h = interpolate(frame, [70 + i * 6, 110 + i * 6], [0, b], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
          return (
            <div key={i} style={{flex: 1, height: `${h}%`, borderRadius: 10, background: `linear-gradient(${C.yellow}, ${C.mid})`}} />
          );
        })}
      </div>
    </div>
  );
};

const Chip: React.FC<{label: string}> = ({label}) => (
  <div style={{...glass, fontFamily: FONT, fontSize: 30, fontWeight: 700, padding: '18px 34px', borderRadius: 999}}>{label}</div>
);

export const Solution: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{opacity: fadeInOut(frame, DUR)}}>
      <Background hue={2} />
      <SFX file="whoosh" at={0} />
      <SFX file="pop" at={30} />
      <SFX file="click" at={70} />
      <SFX file="click" at={95} />
      <AbsoluteFill style={{alignItems: 'center', paddingTop: 70}}>
        <KineticText text="Meet CHARRMPASS" size={96} highlight={['CHARRMPASS']} />
        <div style={{fontFamily: FONT, fontSize: 34, color: C.light, marginTop: 10}}>
          RFID smart parking with real-time monitoring
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 50, paddingTop: 150}}>
        <Floating delay={20}><TapFeed /></Floating>
        <Floating delay={40} phase={2}><Chart /></Floating>
      </AbsoluteFill>
      <AbsoluteFill style={{flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-end', gap: 24, paddingBottom: 60}}>
        <Floating delay={120}><Chip label="RFID Tap-In / Tap-Out" /></Floating>
        <Floating delay={140}><Chip label="Guard Override" /></Floating>
        <Floating delay={160}><Chip label="Online Registration" /></Floating>
        <Floating delay={180}><Chip label="Admin Reports" /></Floating>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
