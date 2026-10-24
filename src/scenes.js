// 几个成对的亮度 + 色温，起个名字。
//
// 为什么要有这东西：允朔醒来想调灯的时候，「亮度 35、色温 2900」这种说法
// 让他得先拿主意凑出两个数字，而他并不知道这屋子里 35 到底是多亮。
// 给好几个已经配好的，他挑一个就行；想自己调仍然可以直接给数字。
//
// 场景里没有「关灯」——关灯是一个独立的、得明确说出口的动作，
// 不该藏在某个听起来很温和的名字后面。
import { lampStatus, lampPower, lampBrightness, lampTemp } from './device.js';

export const SCENES = {
  工作: { brightness: 85, temp: 4800, why: '亮、偏冷白，写代码看文档用' },
  阅读: { brightness: 70, temp: 4000, why: '不刺眼的中性光，看纸书用' },
  看屏: { brightness: 40, temp: 3500, why: '比屏幕暗一点，让眼睛没那么累' },
  储光: { brightness: 25, temp: 3000, why: '晚上不干活、只是呆着的时候' },
  夜灯: { brightness: 8, temp: 2700, why: '最暖最暗，夜里起来喝水不刺眼' },
  暖黄: { brightness: 50, temp: 2700, why: '最暖的色温，亮度还在，像台灯下坐着' },
};

export const sceneNames = () => Object.keys(SCENES);

export const sceneList = () =>
  Object.entries(SCENES)
    .map(([name, s]) => `  ${name}：亮度 ${s.brightness}、色温 ${s.temp}K——${s.why}`)
    .join('\n');

// 套一个场景。
//
// 灯关着的时候默认会先把它开开：「把灯调成阅读」这句话本身就含着「我要用灯」。
// 但 requireOn=false 时不开：给定时和守护用——半夜三点自己把灯开起来是最坏的事。
export async function applyScene(name, { source = 'mcp', note = null, requireOn = true } = {}) {
  const scene = SCENES[String(name ?? '').trim()];
  if (!scene) {
    return { ok: false, error: `没有「${name}」这个场景。现有的：${sceneNames().join('、')}` };
  }

  const st = await lampStatus({ source });
  if (!st.ok) return { ok: false, error: `读不到灯现在的状态，所以没动：${st.error}` };

  const steps = [];

  if (st.on !== true) {
    if (!requireOn) {
      return { ok: true, skipped: true, message: '灯是关着的，这次不动它。', scene: name };
    }
    const r = await lampPower(true, { source, note });
    if (!r.ok) return { ok: false, error: `开灯没成：${r.error}` };
    steps.push('先把灯开了');
  }

  const b = await lampBrightness(scene.brightness, { source, note });
  if (!b.ok) return { ok: false, error: `亮度没调成：${b.error}`, steps };
  steps.push(`亮度 ${scene.brightness}`);

  const t = await lampTemp(scene.temp, { source, note });
  // 色温没调成不算整个失败：亮度已经到位了，灯已经是对的亮度
  if (t.ok) steps.push(`色温 ${scene.temp}K`);

  return {
    ok: true,
    scene: name,
    brightness: scene.brightness,
    temp: scene.temp,
    steps,
    message: `已经按「${name}」调好：${steps.join('、')}${t.ok ? '' : `（色温没调成：${t.error}）`}`,
  };
}
