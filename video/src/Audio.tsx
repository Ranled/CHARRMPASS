import React from 'react';
import {AbsoluteFill, Audio, Sequence, staticFile} from 'remotion';

/**
 * Drop royalty-free files into video/public/audio/ then set ENABLED = true.
 *  music.mp3, whoosh.mp3, pop.mp3, click.mp3
 */
const ENABLED = false;

export const SFX: React.FC<{
  file: 'whoosh' | 'pop' | 'click';
  at: number;
  volume?: number;
}> = ({file, at, volume = 0.6}) =>
  ENABLED ? (
    <Sequence from={at} layout="none">
      <Audio src={staticFile(`audio/${file}.mp3`)} volume={volume} />
    </Sequence>
  ) : null;

export const Music: React.FC = () =>
  ENABLED ? <Audio src={staticFile('audio/music.mp3')} volume={0.35} /> : <AbsoluteFill style={{display: 'none'}} />;
