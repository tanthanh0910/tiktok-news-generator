import { NextResponse } from 'next/server';
import { VOICES, DEFAULT_VOICE_ID } from '@/lib/tts';

export async function GET() {
  return NextResponse.json({
    voices: VOICES.map(({ id, label, provider, gender }) => ({ id, label, provider, gender })),
    defaultVoice: DEFAULT_VOICE_ID,
  });
}
