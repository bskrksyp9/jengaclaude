import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, SafeAreaView, Animated, PanResponder,
  Dimensions, Vibration,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { G, Polygon, Line } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import { GLView } from 'expo-gl';

const { width: SW, height: SH } = Dimensions.get('window');

// ── 2D menu/UI dimensions (still used for non-tower UI) ──────────────────────
const COLS = 3;

// ── 3D block dimensions — real Jenga ratio 3 : 1 : 0.6 ──────────────────────
// World units — blocks sit FLUSH, zero gap
const B3W = 0.75;   // half-width  (long axis)
const B3D = 0.25;   // half-depth  (short axis = 1/3 of width)
const B3H = 0.125;  // half-height (0.6/3 of width)
const B3G = 0.003;  // tiny inter-block gap so edges read clearly

// ── Wood palette — 6 variants ─────────────────────────────────────────────────
// Each has float RGB triplets for top / front / side faces + grain dark/light
const WOOD3 = [
  { t:[0.92,0.65,0.35], f:[0.77,0.49,0.23], s:[0.55,0.34,0.11], gd:[0.62,0.40,0.15], gl:[0.98,0.72,0.40] },
  { t:[0.88,0.62,0.32], f:[0.73,0.46,0.21], s:[0.52,0.31,0.10], gd:[0.58,0.37,0.13], gl:[0.94,0.69,0.37] },
  { t:[0.94,0.67,0.37], f:[0.79,0.51,0.25], s:[0.57,0.36,0.12], gd:[0.64,0.42,0.16], gl:[1.00,0.74,0.42] },
  { t:[0.86,0.60,0.30], f:[0.71,0.44,0.19], s:[0.50,0.30,0.09], gd:[0.56,0.35,0.12], gl:[0.92,0.66,0.35] },
  { t:[0.90,0.64,0.34], f:[0.75,0.48,0.22], s:[0.53,0.33,0.11], gd:[0.60,0.39,0.14], gl:[0.96,0.71,0.39] },
  { t:[0.84,0.58,0.28], f:[0.69,0.42,0.18], s:[0.48,0.28,0.08], gd:[0.54,0.33,0.11], gl:[0.90,0.64,0.33] },
];

// Keep WOOD array for any remaining 2D references
const WOOD = WOOD3.map(w => ({
  top: `rgb(${(w.t[0]*255)|0},${(w.t[1]*255)|0},${(w.t[2]*255)|0})`,
  front: `rgb(${(w.f[0]*255)|0},${(w.f[1]*255)|0},${(w.f[2]*255)|0})`,
  side: `rgb(${(w.s[0]*255)|0},${(w.s[1]*255)|0},${(w.s[2]*255)|0})`,
  grain1:'#D49040', grain2:'#A86228', knot:'#6B3A12',
}));

const LEVELS = [
  { id:1, rows:9,  label:'Beginner',    emoji:'🪵', target:5,  timeLimit:0,   distrChance:0   },
  { id:2, rows:12, label:'Casual',      emoji:'🏗️', target:8,  timeLimit:0,   distrChance:0   },
  { id:3, rows:15, label:'Challenging', emoji:'😤', target:11, timeLimit:120, distrChance:0.3 },
  { id:4, rows:18, label:'Expert',      emoji:'🔥', target:14, timeLimit:90,  distrChance:0.5 },
  { id:5, rows:21, label:'Master',      emoji:'💀', target:17, timeLimit:60,  distrChance:0.7 },
];

const LEVEL_COLORS = [
  { accent:'#C87941', bar:'#C87941' },
  { accent:'#B8682E', bar:'#B8682E' },
  { accent:'#A85820', bar:'#A85820' },
  { accent:'#984818', bar:'#984818' },
  { accent:'#883810', bar:'#883810' },
];
const DIFF_TAGS = ['EASY','CASUAL','MEDIUM','HARD','EXTREME'];

// ── Tiny inline sounds (base64 Web Audio via Expo AV) ─────────────────────────
// We generate sounds programmatically using Audio
async function playTone(freq, duration, type = 'sine', volume = 0.3) {
  try {
    // Use expo-av to play generated tones
    const { sound } = await Audio.Sound.createAsync(
      { uri: `data:audio/wav;base64,${generateWav(freq, duration, volume)}` },
      { shouldPlay: true, volume }
    );
    setTimeout(() => sound.unloadAsync(), duration + 200);
  } catch (e) {}
}

function generateWav(freq, durationMs, vol = 0.3) {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * durationMs / 1000);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  // WAV header
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const envelope = Math.min(1, t * 20) * Math.max(0, 1 - t * (1000 / durationMs) * 0.8);
    const sample = Math.sin(2 * Math.PI * freq * t) * envelope * vol * 32767;
    view.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, sample)), true);
  }
  // Convert to base64
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const SoundFX = {
  async select() { Haptics.selectionAsync(); await playTone(440, 80); },
  async pull()   { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); await playTone(220, 150); await playTone(180, 100); },
  async creak()  { Vibration.vibrate([0,30,15,30]); await playTone(80, 200, 'sawtooth', 0.15); },
  async crash()  { Vibration.vibrate([0,100,50,200,50,300]); await playTone(60,300,undefined,0.4); await playTone(40,500,undefined,0.4); },
  async win()    { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); await playTone(523,100); await playTone(659,100); await playTone(784,200); },
  async distract(){ Vibration.vibrate([0,40,20,40]); await playTone(300, 120); },
  async danger() { await playTone(110, 300, 'sawtooth', 0.2); },
  async tick()   { await playTone(800, 50, undefined, 0.1); },
};

// ── Game logic ────────────────────────────────────────────────────────────────
function buildTower(rows) {
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: COLS }, (_, c) => ({
      id: `${r}-${c}`, row: r, col: c,
      removed: false, horizontal: r % 2 === 0,
      wood: (r * 3 + c) % WOOD.length,
      // Slight random imperfection for natural look
      ox: (Math.random() - 0.5) * 1.5,
      oy: (Math.random() - 0.5) * 0.8,
    }))
  );
}

function getTopRow(tower) {
  for (let r = tower.length - 1; r >= 0; r--)
    if (tower[r].some(b => !b.removed)) return r;
  return 0;
}

function canRemove(block, tower) {
  if (block.removed) return false;
  if (block.row >= getTopRow(tower) - 1) return false;
  return tower[block.row].filter(b => !b.removed).length > 1;
}

// Real structural integrity check
function getInstabilityScore(block, tower) {
  const row = tower[block.row];
  const remaining = row.filter(b => !b.removed && b.id !== block.id);
  const rowsAbove = tower.slice(block.row + 1);
  let unsupported = 0;
  for (const aboveRow of rowsAbove) {
    const aboveRemaining = aboveRow.filter(b => !b.removed);
    if (aboveRemaining.length === 0) continue;
    // Check if above row is supported
    unsupported += aboveRemaining.length;
  }

  // Middle block of a 2-block row = very unstable
  if (remaining.length === 1 && block.col === 1) return 0.85;
  // Last safe block — only 1 left after removal
  if (remaining.length === 1) return 0.6;
  // Center of a 3-block row — structurally safe
  if (block.col === 1 && remaining.length === 2) return 0.1;
  // Edge block — moderate
  return 0.35 + (unsupported / (tower.length * 3)) * 0.2;
}

// ── 3D Tower — WebGL via expo-gl ─────────────────────────────────────────────
// Deterministic per-block random
function brng(slot, n) {
  const v = Math.sin(slot * 127.1 + n * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

// ── GLSL shaders ─────────────────────────────────────────────────────────────
const VS = `
precision highp float;
attribute vec3 aP;
attribute vec3 aN;
attribute vec2 aUV;
attribute float aFace;
attribute float aSlot;
uniform mat4 uVP;
uniform float uTilt;
uniform float uShake;
varying vec2 vUV;
varying vec3 vN;
varying float vFace;
varying float vSlot;
void main(){
  float s=sin(uTilt),c=cos(uTilt);
  vec3 p=aP;
  float ny=p.y*c-p.z*s;
  float nz=p.y*s+p.z*c;
  p=vec3(p.x+uShake,ny,nz);
  gl_Position=uVP*vec4(p,1.0);
  vUV=aUV; vN=aN; vFace=aFace; vSlot=aSlot;
}`;

const FS = `
precision highp float;
varying vec2 vUV;
varying vec3 vN;
varying float vFace;
varying float vSlot;
uniform vec3 uL1;
uniform vec3 uL2;
uniform float uHovSlot;
uniform float uSelSlot;

float h11(float n){return fract(sin(n)*43758.5453);}
float h21(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){
  vec2 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x),u.y);
}
float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.1;a*=0.5;}return v;}

void main(){
  float seed=vSlot*0.317+3.14;
  float hue=h11(seed*2.1)*0.10;

  // Wood ring pattern
  vec2 uv=vUV;
  float warp=fbm(uv*1.2+seed*1.7)*2.0;
  float dist=length(uv*vec2(1.0,2.5)-vec2(0.5+h11(seed)*0.4,0.5+h11(seed*2.0)*0.4));
  float rings=sin((dist+warp)*20.0+seed*5.0);
  rings=smoothstep(-0.15,0.65,rings);

  // Surface bump — uneven wood texture
  float bump=fbm(uv*7.0+seed*3.7)*0.5+noise(uv*22.0+seed*11.0)*0.18;

  // Knot
  vec2 kc=vec2(0.2+h11(seed*3.1)*0.6,0.5+h11(seed*4.2)*0.3);
  float kr=0.06+h11(seed*1.3)*0.05;
  float kn=smoothstep(kr,kr*0.25,length(uv-kc));
  float kn2=0.0;
  if(h11(seed*6.1)>0.5){
    vec2 kc2=vec2(0.2+h11(seed*8.1)*0.6,0.3+h11(seed*9.2)*0.4);
    kn2=smoothstep(kr*0.8,kr*0.2,length(uv-kc2))*0.7;
  }
  float knots=clamp(kn+kn2,0.0,1.0);

  // Base wood colors per face
  vec3 light_wood=vec3(0.90+hue,0.63+hue*0.5,0.34);
  vec3 dark_wood =vec3(0.55+hue*0.5,0.33,0.11);
  vec3 knot_col  =vec3(0.30+hue*0.3,0.16,0.06);

  vec3 woodCol=mix(dark_wood,light_wood,rings);
  woodCol=mix(woodCol*0.74,woodCol*1.06,bump);
  woodCol=mix(woodCol,knot_col,knots*0.82);

  // Scratches
  float scratch=noise(vec2(uv.x*130.0+seed*20.0,uv.y*1.5))*0.12;
  woodCol-=scratch*(1.0-rings)*0.35;

  // Face multiplier: top bright, front mid, side dark
  float fm=vFace<0.5?1.0:(vFace<1.5?0.80:0.60);
  woodCol*=fm;

  // Edge AO
  float edgeAO=smoothstep(0.0,0.12,min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y)));
  float diff1=max(dot(normalize(vN),normalize(uL1)),0.0);
  float diff2=max(dot(normalize(vN),normalize(uL2)),0.0)*0.25;
  float lit=0.30+diff1*0.55+diff2;
  lit*=(0.80+edgeAO*0.20);

  vec3 col=woodCol*lit;

  // Hover / selected
  float isHov=step(abs(vSlot-uHovSlot),0.5);
  float isSel=step(abs(vSlot-uSelSlot),0.5);
  col=mix(col,col+vec3(0.20,0.14,0.02),isHov*(1.0-isSel)*0.9);
  col=mix(col,mix(col,vec3(1.0,0.84,0.22),0.38),isSel);

  col=clamp(col,0.0,1.0);
  col=pow(col,vec3(0.90)); // gamma
  gl_FragColor=vec4(col,1.0);
}`;

// ── Mat4 helpers ──────────────────────────────────────────────────────────────
function m4mul(a,b){
  const r=new Float32Array(16);
  for(let i=0;i<4;i++)for(let j=0;j<4;j++){
    let s=0;for(let k=0;k<4;k++)s+=a[i+k*4]*b[k+j*4];r[i+j*4]=s;
  }return r;
}
function m4persp(fov,asp,n,f){
  const t=1/Math.tan(fov/2),d=f-n;
  return new Float32Array([t/asp,0,0,0, 0,t,0,0, 0,0,-(f+n)/d,-1, 0,0,-2*f*n/d,0]);
}
function m4lookAt(eye,tgt,up){
  const f=norm3(sub3(tgt,eye)),r=norm3(cross3(f,up)),u=cross3(r,f);
  return new Float32Array([
    r[0],u[0],-f[0],0,r[1],u[1],-f[1],0,r[2],u[2],-f[2],0,
    -dot3(r,eye),-dot3(u,eye),dot3(f,eye),1
  ]);
}
const norm3=v=>{const l=Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);return[v[0]/l,v[1]/l,v[2]/l];};
const dot3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross3=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const sub3=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];

// ── Build block geometry (6 faces, tight-packed) ──────────────────────────────
function buildBlockGeom(cx,cy,cz,rotated,slotIdx){
  const [ex,ez]=rotated?[B3W,B3D]:[B3D,B3W];
  const w=ex-B3G, d=ez-B3G, h=B3H-B3G;
  // tiny per-block warp on top surface
  const wp=B3H*0.08;
  const w00=(brng(slotIdx,0)-0.5)*wp, w10=(brng(slotIdx,1)-0.5)*wp;
  const w01=(brng(slotIdx,2)-0.5)*wp, w11=(brng(slotIdx,3)-0.5)*wp;

  const x0=cx-w,x1=cx+w,y0=cy-h,y1=cy+h,z0=cz-d,z1=cz+d;

  // stride: pos(3)+normal(3)+uv(2)+face(1)+slot(1) = 10
  const verts=[],idxs=[];
  let base=0;
  function quad(vs,n,face){
    const uvs=[[0,0],[1,0],[1,1],[0,1]];
    for(let i=0;i<4;i++){
      verts.push(...vs[i],...n,...uvs[i],face,slotIdx);
    }
    idxs.push(base,base+1,base+2,base,base+2,base+3);
    base+=4;
  }
  // top (+Y) — warped
  quad([[x0,y1+w00,z0],[x1,y1+w10,z0],[x1,y1+w11,z1],[x0,y1+w01,z1]],[0,1,0],0);
  // bottom
  quad([[x0,y0,z1],[x1,y0,z1],[x1,y0,z0],[x0,y0,z0]],[0,-1,0],0);
  // front +Z
  quad([[x0,y0,z1],[x1,y0,z1],[x1,y1+w11,z1],[x0,y1+w01,z1]],[0,0,1],1);
  // back -Z
  quad([[x1,y0,z0],[x0,y0,z0],[x0,y1+w00,z0],[x1,y1+w10,z0]],[0,0,-1],1);
  // right +X
  quad([[x1,y0,z1],[x1,y0,z0],[x1,y1+w10,z0],[x1,y1+w11,z1]],[1,0,0],2);
  // left -X
  quad([[x0,y0,z0],[x0,y0,z1],[x0,y1+w01,z1],[x0,y1+w00,z0]],[-1,0,0],2);

  return{verts,idxs};
}

// ── Ray-AABB for picking ──────────────────────────────────────────────────────
function rayAABB(ro,rd,mn,mx){
  let tmin=-1e9,tmax=1e9;
  for(let i=0;i<3;i++){
    const o=ro[i],d=rd[i];
    if(Math.abs(d)<1e-8){if(o<mn[i]||o>mx[i])return null;continue;}
    let t0=(mn[i]-o)/d,t1=(mx[i]-o)/d;
    if(t0>t1)[t0,t1]=[t1,t0];
    tmin=Math.max(tmin,t0);tmax=Math.min(tmax,t1);
    if(tmin>tmax)return null;
  }
  return tmin>0?tmin:null;
}

// ── TowerView3D — full WebGL component ───────────────────────────────────────
function TowerView({ tower, selected, setSelected, onPullBlock, tiltAnim, shakeAnim, levelIdx }) {
  const glRef    = useRef(null);
  const stateRef = useRef({
    gl:null, prog:null, buf_v:null, buf_i:null,
    yaw:0.5, targetYaw:0.5,
    pitch:0.26, targetPitch:0.26,
    towerTilt:0, shakeVal:0,
    hovSlot:-1, selSlot:-1,
    animId:null,
    // rotate gesture
    rotActive:false, rotStartX:0, rotStartY:0,
    rotYaw0:0, rotPitch0:0,
    // pull gesture
    pullActive:false, pullBlock:null, pullStartX:0,
  });

  const blocksRef  = useRef(tower);
  const selectedRef= useRef(selected);
  const tiltRef    = useRef(0);
  const shakeRef   = useRef(0);

  // Keep refs in sync
  useEffect(()=>{ blocksRef.current=tower; },[tower]);
  useEffect(()=>{ selectedRef.current=selected; },[selected]);

  // Sync Animated tilt/shake into refs for GL loop
  useEffect(()=>{
    const tid = tiltAnim.addListener(({value})=>{ tiltRef.current=value*Math.PI/180; });
    const sid = shakeAnim.addListener(({value})=>{ shakeRef.current=value/SW*0.5; });
    return()=>{ tiltAnim.removeListener(tid); shakeAnim.removeListener(sid); };
  },[]);

  // ── GL init ────────────────────────────────────────────────────────────────
  const onContextCreate = useCallback((gl)=>{
    const S = stateRef.current;
    S.gl = gl;

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    // Compile shaders
    function mkS(type,src){
      const s=gl.createShader(type);
      gl.shaderSource(s,src); gl.compileShader(s);
      return s;
    }
    const prog=gl.createProgram();
    gl.attachShader(prog,mkS(gl.VERTEX_SHADER,VS));
    gl.attachShader(prog,mkS(gl.FRAGMENT_SHADER,FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    S.prog=prog;

    S.buf_v=gl.createBuffer();
    S.buf_i=gl.createBuffer();

    // Auto-rotate idle
    let idleTimer=null;
    S.autoRot=true;
    S.stopAutoRot=()=>{ S.autoRot=false; clearTimeout(idleTimer); idleTimer=setTimeout(()=>S.autoRot=true,5000); };

    // ── Render loop ──────────────────────────────────────────────────────────
    const STRIDE=10*4; // 10 floats per vertex
    let last=0;
    function frame(now){
      S.animId=requestAnimationFrame(frame);
      const dt=Math.min((now-last)/1000,0.05); last=now;

      if(S.autoRot&&!S.rotActive&&!S.pullActive) S.targetYaw+=0.008;
      S.yaw   +=(S.targetYaw-S.yaw)*0.10;
      S.pitch +=(S.targetPitch-S.pitch)*0.10;

      // Build geometry
      const blocks=blocksRef.current.flat();
      const sel=selectedRef.current;
      const hovSlot=S.hovSlot, selSlot=sel?sel.row*3+sel.col:-1;

      const allV=[],allI=[];
      let base=0;
      for(const b of blocks){
        if(b.removed)continue;
        const rotated=(b.row%2===0);
        const step=rotated?B3D*2+B3G*2:B3W*2/3+B3G;
        const cx=rotated?0:(b.col-1)*step*2;
        const cz=rotated?(b.col-1)*step*2:0;
        const cy=b.row*(B3H*2+B3G*2)+B3H;
        const slot=b.row*3+b.col;
        const {verts,idxs}=buildBlockGeom(cx,cy,cz,rotated,slot);
        for(const i of idxs) allI.push(i+base);
        allV.push(...verts);
        base+=verts.length/10;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER,S.buf_v);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(allV),gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,S.buf_i);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(allI),gl.DYNAMIC_DRAW);

      const rows=blocksRef.current.length;
      const towerH=rows*(B3H*2+B3G*2);
      const tgtY=towerH*0.44;
      const dist=3.8;
      const eye=[
        Math.sin(S.yaw)*Math.cos(S.pitch)*dist,
        Math.sin(S.pitch)*dist+tgtY,
        Math.cos(S.yaw)*Math.cos(S.pitch)*dist,
      ];
      const asp=(gl.drawingBufferWidth||SW)/(gl.drawingBufferHeight||(SH*0.5));
      const proj=m4persp(0.82,asp,0.05,50);
      const view=m4lookAt(eye,[0,tgtY,0],[0,1,0]);
      const vp=m4mul(proj,view);

      gl.clearColor(0.030,0.012,0.004,1);
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);

      gl.useProgram(prog);
      gl.uniformMatrix4fv(gl.getUniformLocation(prog,'uVP'),false,vp);
      gl.uniform1f(gl.getUniformLocation(prog,'uTilt'),tiltRef.current);
      gl.uniform1f(gl.getUniformLocation(prog,'uShake'),shakeRef.current);
      gl.uniform3fv(gl.getUniformLocation(prog,'uL1'),[1.2,2.8,1.8]);
      gl.uniform3fv(gl.getUniformLocation(prog,'uL2'),[-0.8,0.6,-0.4]);
      gl.uniform1f(gl.getUniformLocation(prog,'uHovSlot'),hovSlot);
      gl.uniform1f(gl.getUniformLocation(prog,'uSelSlot'),selSlot);

      gl.bindBuffer(gl.ARRAY_BUFFER,S.buf_v);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,S.buf_i);
      function ba(name,size,off){
        const loc=gl.getAttribLocation(prog,name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc,size,gl.FLOAT,false,STRIDE,off*4);
      }
      ba('aP',3,0); ba('aN',3,3); ba('aUV',2,6); ba('aFace',1,8); ba('aSlot',1,9);
      gl.drawElements(gl.TRIANGLES,allI.length,gl.UNSIGNED_SHORT,0);
      gl.flush();
      gl.endFrameEXP();
    }
    requestAnimationFrame(frame);
  },[]);

  // ── Touch handlers — CLEAN separation ────────────────────────────────────
  // Single touch on a block = pull drag
  // Single touch on empty   = rotation
  // NEVER mix mid-gesture

  function getBlock3D(px,py){
    const S=stateRef.current;
    const blocks=blocksRef.current.flat();
    const rows=blocksRef.current.length;
    const towerH=rows*(B3H*2+B3G*2);
    const tgtY=towerH*0.44;
    const dist=3.8;
    const eye=[
      Math.sin(S.yaw)*Math.cos(S.pitch)*dist,
      Math.sin(S.pitch)*dist+tgtY,
      Math.cos(S.yaw)*Math.cos(S.pitch)*dist,
    ];
    const ndcX=(px/SW)*2-1;
    const ndcY=-((py/(SH*0.5))*2-1);
    const fwd=norm3(sub3([0,tgtY,0],eye));
    const rgt=norm3(cross3(fwd,[0,1,0]));
    const upv=cross3(rgt,fwd);
    const asp=SW/(SH*0.5);
    const th=Math.tan(0.82/2);
    const dir=norm3([
      fwd[0]+rgt[0]*ndcX*asp*th+upv[0]*ndcY*th,
      fwd[1]+rgt[1]*ndcX*asp*th+upv[1]*ndcY*th,
      fwd[2]+rgt[2]*ndcX*asp*th+upv[2]*ndcY*th,
    ]);
    // Get top row
    const flat=blocks.filter(b=>!b.removed);
    let topRow=0;
    for(const b of flat) if(b.row>topRow) topRow=b.row;

    let best=null,bestT=1e9;
    for(const b of flat){
      if(b.removed) continue;
      if(b.row>=topRow-1) continue;
      if(flat.filter(x=>x.row===b.row).length<2) continue;
      const rotated=(b.row%2===0);
      const step=rotated?B3D*2+B3G*2:B3W*2/3+B3G;
      const cx=rotated?0:(b.col-1)*step*2;
      const cz=rotated?(b.col-1)*step*2:0;
      const cy=b.row*(B3H*2+B3G*2)+B3H;
      const ex=rotated?B3W:B3D, ez=rotated?B3D:B3W;
      const t=rayAABB(eye,dir,[cx-ex,cy-B3H,cz-ez],[cx+ex,cy+B3H,cz+ez]);
      if(t&&t<bestT){bestT=t;best=b;}
    }
    return best;
  }

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: ()=>true,
    onMoveShouldSetPanResponder: (_,g)=>Math.abs(g.dx)>3||Math.abs(g.dy)>3,

    onPanResponderGrant: (e)=>{
      const S=stateRef.current;
      S.stopAutoRot?.();
      const px=e.nativeEvent.locationX??e.nativeEvent.pageX;
      const py=e.nativeEvent.locationY??e.nativeEvent.pageY;
      const hit=getBlock3D(px,py);
      if(hit){
        S.pullActive=true; S.pullBlock=hit;
        S.pullStartX=e.nativeEvent.pageX;
        S.hovSlot=hit.row*3+hit.col;
        setSelected(hit);
        SoundFX.select();
      } else {
        S.rotActive=true;
        S.rotStartX=e.nativeEvent.pageX;
        S.rotStartY=e.nativeEvent.pageY;
        S.rotYaw0=S.yaw; S.rotPitch0=S.pitch;
      }
    },

    onPanResponderMove: (_,g)=>{
      const S=stateRef.current;
      if(S.rotActive){
        // ONLY rotation — yaw from horizontal, pitch from vertical
        S.targetYaw   = S.rotYaw0   + g.dx * 0.008;
        S.targetPitch = Math.max(-0.05, Math.min(0.62,
          S.rotPitch0 - g.dy * 0.006));
      }
      if(S.pullActive&&S.pullBlock){
        // Show creak feedback
        if(Math.abs(g.dx)>18) SoundFX.creak();
      }
    },

    onPanResponderRelease: (_,g)=>{
      const S=stateRef.current;
      if(S.pullActive&&S.pullBlock){
        const threshold=SW*0.20;
        if(Math.abs(g.dx)>=threshold){
          onPullBlock(S.pullBlock,g.dx);
        } else {
          SoundFX.creak();
          setSelected(null);
        }
      }
      S.rotActive=false; S.pullActive=false;
      S.pullBlock=null; S.hovSlot=-1;
      setSelected(null);
    },

    onPanResponderTerminate: ()=>{
      const S=stateRef.current;
      S.rotActive=false; S.pullActive=false;
      S.pullBlock=null; S.hovSlot=-1;
      setSelected(null);
    },
  })).current;

  useEffect(()=>()=>{
    const S=stateRef.current;
    if(S.animId) cancelAnimationFrame(S.animId);
  },[]);

  return (
    <View style={{ flex:1 }} {...panResponder.panHandlers}>
      <GLView
        style={{ flex:1 }}
        onContextCreate={onContextCreate}
      />
    </View>
  );
}


// ── Distraction overlay ───────────────────────────────────────────────────────
function DistractionBanner({ distraction }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.spring(anim, { toValue: 1, tension: 70, friction: 6, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(anim, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start();
  }, [distraction?.id]);

  if (!distraction) return null;
  return (
    <Animated.View style={[S.distrBanner, { opacity: anim, transform: [{ scale: anim.interpolate({ inputRange:[0,1], outputRange:[0.7,1] }) }] }]}>
      <Text style={S.distrTitle}>{distraction.icon} {distraction.label}</Text>
      <Text style={S.distrDesc}>{distraction.desc}</Text>
    </Animated.View>
  );
}

// ── Score popup ───────────────────────────────────────────────────────────────
function ScorePopup({ score, color, onDone }) {
  const y = useRef(new Animated.Value(0)).current;
  const op = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.timing(y, { toValue: -60, duration: 900, useNativeDriver: true }),
      Animated.sequence([Animated.delay(400), Animated.timing(op, { toValue: 0, duration: 500, useNativeDriver: true })]),
    ]).start(() => onDone?.());
  }, []);
  return (
    <Animated.Text style={[S.scorePopup, { color, opacity: op, transform: [{ translateY: y }] }]}>
      +{score}
    </Animated.Text>
  );
}

// ── Menu ──────────────────────────────────────────────────────────────────────
function MenuScreen({ onStart, unlockedLevels, highScores }) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.spring(slideAnim, { toValue: 0, tension: 60, friction: 10, useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <LinearGradient colors={['#0D0602','#180C05','#221208','#1A0D06']} style={S.root}>
      <SafeAreaView style={S.safe}>
        <ScrollView contentContainerStyle={S.menuScroll} showsVerticalScrollIndicator={false}>

          {/* Hero Logo */}
          <Animated.View style={[S.heroBox, { opacity: fadeAnim, transform: [{ translateY: slideAnim }] }]}>
            <View style={S.logoRing}>
              <Text style={S.logoIcon}>🪵</Text>
            </View>
            <Text style={S.logo}>JENGA</Text>
            <View style={S.logoDivRow}>
              <View style={S.logoDivLine} />
              <Text style={S.logoDivDot}>◆</Text>
              <View style={S.logoDivLine} />
            </View>
            <Text style={S.logoTagline}>DRAG · PULL · SURVIVE</Text>
          </Animated.View>

          {/* How to play */}
          <Animated.View style={[S.howToBox, { opacity: fadeAnim }]}>
            <View style={S.howToHeader}>
              <View style={S.howToLine} />
              <Text style={S.howToTitle}>HOW TO PLAY</Text>
              <View style={S.howToLine} />
            </View>
            {[
              { icon:'👈', text:'Swipe a block left or right to pull it' },
              { icon:'⚡', text:'Must drag past 65% — short swipe snaps back' },
              { icon:'🎯', text:'Center blocks are safe · Edge blocks are risky' },
              { icon:'☠️', text:'Last 2 in a row? Pulling the middle = collapse!' },
            ].map((item, i) => (
              <View key={i} style={S.howToRow}>
                <Text style={S.howToIcon}>{item.icon}</Text>
                <Text style={S.howToText}>{item.text}</Text>
              </View>
            ))}
          </Animated.View>

          {/* Section label */}
          <View style={S.sectionHeader}>
            <View style={S.sectionLine} />
            <Text style={S.sectionLabel}>SELECT LEVEL</Text>
            <View style={S.sectionLine} />
          </View>

          {/* Level Cards */}
          {LEVELS.map((lvl, i) => {
            const locked = !unlockedLevels.includes(i);
            const hs = highScores[i] || 0;
            const accent = LEVEL_COLORS[i].accent;
            return (
              <TouchableOpacity
                key={lvl.id}
                style={[S.lvlCard, locked && S.lvlCardLocked]}
                disabled={locked}
                onPress={() => onStart(i)}
                activeOpacity={0.82}
              >
                {/* Left accent stripe */}
                <View style={[S.lvlStripe, { backgroundColor: locked ? '#2A1A0A' : accent }]} />

                {/* Emoji + info */}
                <View style={S.lvlBody}>
                  <View style={S.lvlTopRow}>
                    <Text style={S.lvlEmoji}>{locked ? '🔒' : lvl.emoji}</Text>
                    <View style={S.lvlMeta}>
                      <View style={S.lvlBadgeRow}>
                        <View style={[S.diffBadge, { backgroundColor: locked ? '#1C0E06' : accent + '22', borderColor: locked ? '#2A1A0A' : accent + '55' }]}>
                          <Text style={[S.diffBadgeText, { color: locked ? '#3A2010' : accent }]}>{DIFF_TAGS[i]}</Text>
                        </View>
                        {lvl.timeLimit > 0 && !locked && (
                          <View style={S.timerBadge}>
                            <Text style={S.timerBadgeText}>⏱ {lvl.timeLimit}s</Text>
                          </View>
                        )}
                        {lvl.distrChance > 0 && !locked && (
                          <View style={S.distrBadge}>
                            <Text style={S.distrBadgeText}>💥 CHAOS</Text>
                          </View>
                        )}
                      </View>
                      <Text style={[S.lvlName, { color: locked ? '#3A2010' : '#E0A060' }]}>{lvl.label}</Text>
                      <Text style={[S.lvlSubInfo, { color: locked ? '#2A1408' : '#6A4828' }]}>{lvl.rows} rows · pull {lvl.target} blocks</Text>
                    </View>
                  </View>
                  {!locked && hs > 0 && (
                    <View style={S.hsRow}>
                      <Text style={S.hsTrophy}>🏆</Text>
                      <Text style={S.hsVal}>{hs.toLocaleString()}</Text>
                    </View>
                  )}
                </View>

                {/* Arrow */}
                {!locked && (
                  <View style={S.lvlArrow}>
                    <Text style={[S.lvlArrowText, { color: accent }]}>›</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}

          {/* Credits */}
          <View style={S.creditsBox}>
            <View style={S.creditsDivRow}>
              <View style={S.creditsDivLine} />
              <Text style={S.creditsDivDot}>◆</Text>
              <View style={S.creditsDivLine} />
            </View>
            <Text style={S.creditsTitle}>CREDITS</Text>
            <Text style={S.creditsLine}>
              <Text style={S.creditsLabel}>🎮 Game Dev  </Text>
              <Text style={S.creditsName}>Claude</Text>
            </Text>
            <Text style={S.creditsLine}>
              <Text style={S.creditsLabel}>🧠 Prompt Engineer  </Text>
              <Text style={S.creditsName}>Skarabhaa</Text>
            </Text>
          </View>

        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

// ── Game Screen ───────────────────────────────────────────────────────────────
function GameScreen({
  levelIdx, tower, selected, setSelected,
  tiltAnim, shakeAnim,
  removedCount, stability, score, combo,
  timeLeft, distraction, scorePopups,
  onPullBlock, onMenu, onPopupDone,
}) {
  const lvl = LEVELS[levelIdx];
  const lc = LEVEL_COLORS[levelIdx];
  const stabColor = stability > 60 ? '#6DBF6A' : stability > 30 ? '#F5C842' : '#EF5350';
  const stabBgColor = stability > 60 ? 'rgba(109,191,106,0.1)' : stability > 30 ? 'rgba(245,200,66,0.1)' : 'rgba(239,83,80,0.1)';
  const isTimedLevel = lvl.timeLimit > 0;
  const timeWarning = isTimedLevel && timeLeft <= 15;
  const progress = Math.min(removedCount / lvl.target, 1);

  return (
    <LinearGradient colors={['#080401','#100702','#180C03','#1E0F04']} style={S.root}>
      <SafeAreaView style={S.safe}>

        {/* ── Top HUD ── */}
        <View style={S.hdr}>
          <TouchableOpacity onPress={onMenu} style={S.backBtn} activeOpacity={0.7}>
            <Text style={S.backArrow}>‹</Text>
            <Text style={S.backTxt}>MENU</Text>
          </TouchableOpacity>
          <View style={S.hdrCenter}>
            <Text style={S.hdrEmoji}>{lvl.emoji}</Text>
            <Text style={S.hdrName}>{lvl.label.toUpperCase()}</Text>
          </View>
          <View style={S.scorePill}>
            <Text style={S.scoreN}>{score.toLocaleString()}</Text>
            <Text style={S.scoreL}>PTS</Text>
          </View>
        </View>

        {/* ── Metrics Row ── */}
        <View style={S.metricsRow}>
          <View style={S.metricSlot}>
            {combo > 1 ? (
              <View style={S.comboBadge}>
                <Text style={S.comboTxt}>🔥 ×{combo}</Text>
              </View>
            ) : (
              <View style={S.comboBadgeDim}><Text style={S.comboDimTxt}>×1</Text></View>
            )}
          </View>
          <View style={S.progressTrack}>
            <View style={[S.progressFill, { width:`${progress * 100}%`, backgroundColor:lc.bar }]} />
            <Text style={S.progressTxt}>{removedCount}/{lvl.target}</Text>
          </View>
          <View style={S.metricSlot}>
            {isTimedLevel ? (
              <View style={[S.timerPill, timeWarning && S.timerPillWarn]}>
                <Text style={[S.timerTxt, timeWarning && {color:'#FF5252'}]}>⏱ {timeLeft}s</Text>
              </View>
            ) : (
              <View style={S.timerPillDim}><Text style={S.timerDimTxt}>∞</Text></View>
            )}
          </View>
        </View>

        {/* ── Hint ── */}
        <View style={S.hintWrap}>
          <View style={S.hintPill}>
            <Text style={S.hintTxt}>
              {selected ? '‹ Drag left or right to pull ›' : '↻ Drag to rotate · Touch block to pull'}
            </Text>
          </View>
        </View>

        {/* ── Tower Area — WebGL 3D ── */}
        <View style={{ flex:1 }}>
          <TowerView
            tower={tower} selected={selected} setSelected={setSelected}
            onPullBlock={onPullBlock} tiltAnim={tiltAnim} shakeAnim={shakeAnim}
            levelIdx={levelIdx}
          />
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {scorePopups.map(p => (
              <View key={p.id} style={[StyleSheet.absoluteFill, {justifyContent:'center', alignItems:'center'}]}>
                <ScorePopup score={p.score} color={p.color} onDone={() => onPopupDone(p.id)} />
              </View>
            ))}
          </View>
          <View style={[StyleSheet.absoluteFill, {justifyContent:'center', alignItems:'center'}]} pointerEvents="none">
            <DistractionBanner distraction={distraction} />
          </View>
        </View>

        {/* ── Stability Bar ── */}
        <View style={[S.stabWrap, { backgroundColor:stabBgColor }]}>
          <View style={S.stabTop}>
            <Text style={S.stabLbl}>STRUCTURAL INTEGRITY</Text>
            <Text style={[S.stabPct, { color:stabColor }]}>{Math.round(stability)}%</Text>
          </View>
          <View style={S.stabTrack}>
            {[...Array(20)].map((_,i) => (
              <View key={i} style={[
                S.stabSeg,
                { backgroundColor: (i/20) < (stability/100) ? stabColor : 'rgba(255,255,255,0.06)' },
              ]} />
            ))}
          </View>
          {stability < 30 && (
            <View style={S.dangerBanner}>
              <Text style={S.dangerTxt}>⚠  CRITICAL — ONE WRONG MOVE</Text>
            </View>
          )}
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}

// ── Result ────────────────────────────────────────────────────────────────────
function ResultScreen({ won, levelIdx, removedCount, score, highScore, isNewHigh, onReplay, onNext, onMenu }) {
  const anim = useRef(new Animated.Value(0)).current;
  const iconAnim = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(anim, { toValue:1, tension:55, friction:7, useNativeDriver:true }),
      Animated.spring(iconAnim, { toValue:1, tension:40, friction:5, delay:150, useNativeDriver:true }),
    ]).start();
  }, []);
  const lc = LEVEL_COLORS[Math.min(levelIdx, LEVEL_COLORS.length - 1)];
  return (
    <LinearGradient
      colors={won ? ['#050F06','#091A0B','#0E2810','#132E14'] : ['#0F0404','#1C0707','#280B0B','#301010']}
      style={S.root}
    >
      <SafeAreaView style={S.safe}>
        <Animated.View style={[S.resWrap, {
          opacity: anim,
          transform:[{ scale: anim.interpolate({ inputRange:[0,1], outputRange:[0.88,1] }) }],
        }]}>
          <Animated.View style={[S.resIconWrap, { transform:[{scale:iconAnim}] }]}>
            <View style={[S.resIconRing, { borderColor: won ? '#4CAF5055' : '#EF535055' }]}>
              <Text style={S.resIcon}>{won ? '🏆' : '💥'}</Text>
            </View>
          </Animated.View>
          <Text style={[S.resTitle, { color: won ? '#6DBF6A' : '#EF5350' }]}>
            {won ? 'TOWER SURVIVED!' : 'TOWER FELL!'}
          </Text>
          <Text style={[S.resSubtitle, { color: won ? '#3A8C38' : '#8C2020' }]}>
            {won ? `Level ${levelIdx + 1} Complete` : 'Better luck next time'}
          </Text>
          <View style={[S.scoreCard, { borderColor: won ? '#1E5C1E' : '#5C1E1E' }]}>
            <View style={S.scoreCardRow}>
              <Text style={S.sk}>Blocks Removed</Text>
              <Text style={S.sv}>{removedCount}</Text>
            </View>
            <View style={S.scoreCardDivider} />
            <View style={S.scoreCardRow}>
              <Text style={S.sk}>Score</Text>
              <Text style={[S.sv, { color:'#FFD700', fontSize:20 }]}>{score.toLocaleString()}</Text>
            </View>
            {isNewHigh ? (
              <>
                <View style={S.scoreCardDivider} />
                <View style={[S.scoreCardRow, S.newHighRow]}>
                  <Text style={S.newHighLabel}>🌟 NEW PERSONAL BEST</Text>
                  <Text style={S.newHighVal}>{score.toLocaleString()}</Text>
                </View>
              </>
            ) : highScore > 0 && (
              <>
                <View style={S.scoreCardDivider} />
                <View style={S.scoreCardRow}>
                  <Text style={S.sk}>Personal Best</Text>
                  <Text style={S.sv}>{highScore.toLocaleString()}</Text>
                </View>
              </>
            )}
          </View>
          <TouchableOpacity style={[S.resBtn, S.resBtnPrimary]} onPress={onReplay} activeOpacity={0.8}>
            <Text style={S.rbt}>🔄  PLAY AGAIN</Text>
          </TouchableOpacity>
          {won && levelIdx + 1 < LEVELS.length && (
            <TouchableOpacity style={[S.resBtn, S.resBtnNext]} onPress={onNext} activeOpacity={0.8}>
              <Text style={S.rbt}>NEXT LEVEL  ›</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[S.resBtn, S.resBtnMenu]} onPress={onMenu} activeOpacity={0.8}>
            <Text style={[S.rbt, { color:'#6B4020' }]}>MAIN MENU</Text>
          </TouchableOpacity>
        </Animated.View>
      </SafeAreaView>
    </LinearGradient>
  );
}

// ── DISTRACTIONS ──────────────────────────────────────────────────────────────
const DISTRACTIONS_LIST = [
  {
    id: 'wind', icon: '💨', label: 'WIND GUST!', desc: 'A sudden wind shakes the tower',
    effect: (tiltRef, tiltAnim) => {
      const push = (Math.random() > 0.5 ? 1 : -1) * (5 + Math.random() * 6);
      const nt = Math.max(-22, Math.min(22, tiltRef.current + push));
      tiltRef.current = nt;
      Animated.spring(tiltAnim, { toValue: nt, tension: 25, friction: 5, useNativeDriver: true }).start();
    },
  },
  {
    id: 'quake', icon: '🌍', label: 'MICRO-QUAKE!', desc: 'The ground trembles briefly',
    effect: (tiltRef, tiltAnim, shakeAnim) => {
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue: 12, duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -12, duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 8, duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -8, duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 4, duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 0, duration: 60, useNativeDriver: true }),
      ]).start();
      Vibration.vibrate([0, 50, 30, 50, 30, 50]);
    },
  },
  {
    id: 'bump', icon: '🤦', label: 'TABLE BUMPED!', desc: 'Someone bumped the table!',
    effect: (tiltRef, tiltAnim, shakeAnim) => {
      const push = (Math.random() > 0.5 ? 1 : -1) * (3 + Math.random() * 4);
      const nt = Math.max(-22, Math.min(22, tiltRef.current + push));
      tiltRef.current = nt;
      Animated.spring(tiltAnim, { toValue: nt, tension: 30, friction: 6, useNativeDriver: true }).start();
      Vibration.vibrate([0, 80, 40, 80]);
    },
  },
  {
    id: 'sneeze', icon: '🤧', label: 'ACHOO!', desc: 'Someone sneezed on the tower!',
    effect: (_, __, shakeAnim) => {
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue: 8, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -8, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 4, duration: 50, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
      ]).start();
      Vibration.vibrate([0, 40, 20, 40]);
    },
  },
];

// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState('menu');
  const [levelIdx, setLevelIdx] = useState(0);
  const [tower, setTower] = useState([]);
  const [selected, setSelected] = useState(null);
  const [removedCount, setRemovedCount] = useState(0);
  const [stability, setStability] = useState(100);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(1);
  const [won, setWon] = useState(false);
  const [unlockedLevels, setUnlockedLevels] = useState([0]);
  const [highScores, setHighScores] = useState({});
  const [timeLeft, setTimeLeft] = useState(0);
  const [distraction, setDistraction] = useState(null);
  const [scorePopups, setScorePopups] = useState([]);
  const [gameOver, setGameOver] = useState(false);

  const tiltAnim = useRef(new Animated.Value(0)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const tiltVal = useRef(0);
  const timerRef = useRef(null);
  const distrRef = useRef(null);
  const comboRef = useRef(null);
  const gameOverRef = useRef(false);

  const cleanup = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (distrRef.current) clearInterval(distrRef.current);
    if (comboRef.current) clearTimeout(comboRef.current);
  };

  const triggerCollapse = useCallback((currentTilt) => {
    if (gameOverRef.current) return;
    gameOverRef.current = true;
    cleanup();
    SoundFX.crash();
    Animated.timing(tiltAnim, {
      toValue: currentTilt > 0 ? 85 : -85,
      duration: 600,
      useNativeDriver: true,
    }).start();
    setWon(false);
    setTimeout(() => setScreen('result'), 800);
  }, []);

  const startLevel = useCallback((idx) => {
    cleanup();
    gameOverRef.current = false;
    const cfg = LEVELS[idx];
    setLevelIdx(idx);
    setTower(buildTower(cfg.rows));
    setSelected(null);
    tiltVal.current = 0;
    tiltAnim.setValue(0);
    shakeAnim.setValue(0);
    setRemovedCount(0);
    setStability(100);
    setScore(0);
    setCombo(1);
    setWon(false);
    setDistraction(null);
    setScorePopups([]);
    setGameOver(false);

    // Timer
    if (cfg.timeLimit > 0) {
      setTimeLeft(cfg.timeLimit);
      timerRef.current = setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 1) {
            triggerCollapse(tiltVal.current);
            return 0;
          }
          if (prev <= 10) SoundFX.tick();
          return prev - 1;
        });
      }, 1000);
    }

    // Distractions
    if (cfg.distrChance > 0) {
      const scheduleDistraction = () => {
        const delay = 12000 + Math.random() * 10000;
        distrRef.current = setTimeout(() => {
          if (gameOverRef.current) return;
          if (Math.random() < cfg.distrChance) {
            const d = DISTRACTIONS_LIST[Math.floor(Math.random() * DISTRACTIONS_LIST.length)];
            setDistraction(d);
            SoundFX.distract();
            d.effect(tiltVal, tiltAnim, shakeAnim);
            // Check collapse after distraction
            setTimeout(() => {
              if (Math.abs(tiltVal.current) > 20) triggerCollapse(tiltVal.current);
            }, 800);
          }
          scheduleDistraction();
        }, delay);
      };
      scheduleDistraction();
    }

    setScreen('game');
  }, [triggerCollapse]);

  useEffect(() => () => cleanup(), []);

  const handlePullBlock = useCallback((block, dragDx) => {
    if (gameOverRef.current) return;
    const cfg = LEVELS[levelIdx];

    SoundFX.pull();
    setSelected(null);

    const newTower = tower.map(row =>
      row.map(b => b.id === block.id ? { ...b, removed: true } : b)
    );
    setTower(newTower);

    const newCount = removedCount + 1;
    setRemovedCount(newCount);

    // Structural integrity — real physics model
    const instability = getInstabilityScore(block, tower);
    const rowHeight = block.row / cfg.rows;

    // Pulling direction matters — wrong way = more tilt
    const naturalDir = block.col === 0 ? -1 : block.col === 2 ? 1 : 0;
    const pulledDir = dragDx > 0 ? 1 : -1;
    const directionFactor = naturalDir !== 0 && pulledDir === naturalDir ? 1.8 : 1.0;

    const magnitude = (instability * 8 + rowHeight * 4 + 1) * directionFactor;
    const direction = pulledDir;
    const noise = (Math.random() - 0.5) * 2;
    const newTilt = Math.max(-22, Math.min(22, tiltVal.current + direction * magnitude + noise));
    tiltVal.current = newTilt;

    Animated.spring(tiltAnim, {
      toValue: newTilt,
      tension: 30,
      friction: 6,
      useNativeDriver: true,
    }).start();

    if (Math.abs(newTilt) > 10) SoundFX.creak();

    // Stability — based on structural integrity
    const tiltPenalty = Math.pow(Math.abs(newTilt) / 22, 1.6) * 55;
    const strucPenalty = instability * 25 + rowHeight * 15;
    const pullPenalty = newCount * (40 / (cfg.rows * 2));
    const newStab = Math.max(0, 100 - tiltPenalty - strucPenalty - pullPenalty);
    setStability(newStab);

    if (newStab < 30) SoundFX.danger();

    // Score
    const isEdge = block.col !== 1;
    const isHighRow = rowHeight > 0.6;
    const baseScore = isEdge ? 180 : 90;
    const heightBonus = Math.floor(rowHeight * 120);
    const comboBonus = combo > 1 ? combo * 30 : 0;
    const newCombo = combo + 1;
    setCombo(newCombo);
    if (comboRef.current) clearTimeout(comboRef.current);
    comboRef.current = setTimeout(() => setCombo(1), 8000);
    const pts = baseScore + heightBonus + comboBonus;
    const newScore = score + pts;
    setScore(newScore);

    const popId = Date.now();
    setScorePopups(prev => [...prev, {
      id: popId,
      score: pts,
      color: isEdge ? '#FF6B35' : isHighRow ? '#FFD700' : '#90EE90',
    }]);

    // Collapse probability — much harder now
    // Middle block exploit is fixed: instability score is 0.85 for last-middle block
    const collapseProbability =
      Math.pow(instability, 1.4) * 0.7 +
      Math.pow(Math.abs(newTilt) / 22, 2.0) * 0.5 +
      Math.pow(1 - newStab / 100, 2.0) * 0.4;

    if (Math.random() < collapseProbability || Math.abs(newTilt) > 20 || newStab < 5) {
      triggerCollapse(newTilt);
      return;
    }

    // Win
    if (newCount >= cfg.target) {
      cleanup();
      SoundFX.win();
      gameOverRef.current = true;
      const next = levelIdx + 1;
      if (next < LEVELS.length)
        setUnlockedLevels(prev => prev.includes(next) ? prev : [...prev, next]);
      setHighScores(prev => ({ ...prev, [levelIdx]: Math.max(prev[levelIdx] || 0, newScore) }));
      setWon(true);
      setTimeout(() => setScreen('result'), 600);
    }
  }, [tower, levelIdx, removedCount, score, combo, triggerCollapse]);

  const isNewHigh = score > (highScores[levelIdx] || 0);

  return (
    <>
      <StatusBar style="light" />
      {screen === 'menu' && <MenuScreen onStart={startLevel} unlockedLevels={unlockedLevels} highScores={highScores} />}
      {screen === 'game' && (
        <GameScreen
          levelIdx={levelIdx} tower={tower}
          selected={selected} setSelected={setSelected}
          tiltAnim={tiltAnim} shakeAnim={shakeAnim}
          removedCount={removedCount} stability={stability}
          score={score} combo={combo} timeLeft={timeLeft}
          distraction={distraction} scorePopups={scorePopups}
          onPullBlock={handlePullBlock}
          onMenu={() => { cleanup(); gameOverRef.current = true; setScreen('menu'); }}
          onPopupDone={(id) => setScorePopups(prev => prev.filter(p => p.id !== id))}
        />
      )}
      {screen === 'result' && (
        <ResultScreen
          won={won} levelIdx={levelIdx} removedCount={removedCount}
          score={score} highScore={highScores[levelIdx] || 0} isNewHigh={isNewHigh}
          onReplay={() => startLevel(levelIdx)}
          onNext={() => startLevel(levelIdx + 1)}
          onMenu={() => setScreen('menu')}
        />
      )}
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  // ── Shared
  root:{ flex:1 },
  safe:{ flex:1 },

  // ── Menu scroll
  menuScroll:{
    alignItems:'center', paddingHorizontal:20,
    paddingTop:28, paddingBottom:28,
  },

  // ── Hero logo block
  heroBox:{ alignItems:'center', marginBottom:28, width:'100%' },
  logoRing:{
    width:72, height:72, borderRadius:36,
    backgroundColor:'rgba(180,100,30,0.10)',
    borderWidth:1, borderColor:'rgba(200,130,50,0.28)',
    alignItems:'center', justifyContent:'center', marginBottom:14,
  },
  logoIcon:{ fontSize:32 },
  logo:{
    fontSize:52, fontWeight:'900', color:'#D9914A',
    letterSpacing:16, marginBottom:10,
    textShadowColor:'rgba(200,100,20,0.35)',
    textShadowOffset:{ width:0, height:3 },
    textShadowRadius:12,
  },
  logoDivRow:{ flexDirection:'row', alignItems:'center', gap:10, marginBottom:10, width:160 },
  logoDivLine:{ flex:1, height:1, backgroundColor:'#3E2010' },
  logoDivDot:{ color:'#7B4A20', fontSize:7 },
  logoTagline:{ fontSize:9, color:'#5E3A1A', letterSpacing:4, fontWeight:'700' },

  // ── How to play box
  howToBox:{
    width:'100%', borderRadius:16,
    backgroundColor:'rgba(20,10,4,0.85)',
    borderWidth:1, borderColor:'rgba(80,45,15,0.30)',
    padding:16, marginBottom:22,
  },
  howToHeader:{ flexDirection:'row', alignItems:'center', gap:10, marginBottom:14 },
  howToLine:{ flex:1, height:1, backgroundColor:'rgba(80,45,15,0.4)' },
  howToTitle:{ color:'#7A5030', fontSize:9, fontWeight:'900', letterSpacing:3 },
  howToRow:{ flexDirection:'row', alignItems:'flex-start', gap:12, marginBottom:9 },
  howToIcon:{ fontSize:15, width:22, textAlign:'center', marginTop:1 },
  howToText:{ color:'#7A5A38', fontSize:12, lineHeight:19, flex:1 },

  // ── Section header
  sectionHeader:{ flexDirection:'row', alignItems:'center', gap:10, width:'100%', marginBottom:14, marginTop:4 },
  sectionLine:{ flex:1, height:1, backgroundColor:'#2E1608' },
  sectionLabel:{ color:'#5A3520', fontSize:9, fontWeight:'900', letterSpacing:3 },

  // ── Level card
  lvlCard:{
    width:'100%', borderRadius:16,
    backgroundColor:'rgba(18,9,3,0.98)',
    borderWidth:1, borderColor:'rgba(70,38,12,0.55)',
    marginBottom:12, overflow:'hidden', elevation:8,
    flexDirection:'row', alignItems:'stretch',
    shadowColor:'#000', shadowOffset:{ width:0, height:4 },
    shadowOpacity:0.4, shadowRadius:8,
  },
  lvlCardLocked:{ opacity:0.3 },
  lvlStripe:{ width:5 },
  lvlBody:{ flex:1, padding:14, paddingLeft:14 },
  lvlTopRow:{ flexDirection:'row', alignItems:'center', gap:12 },
  lvlEmoji:{ fontSize:26 },
  lvlMeta:{ flex:1, gap:4 },
  lvlBadgeRow:{ flexDirection:'row', gap:6, flexWrap:'wrap' },
  diffBadge:{
    borderRadius:6, paddingHorizontal:7, paddingVertical:2,
    borderWidth:1,
  },
  diffBadgeText:{ fontSize:9, fontWeight:'900', letterSpacing:1.5 },
  timerBadge:{
    backgroundColor:'rgba(100,160,220,0.12)',
    borderRadius:6, paddingHorizontal:7, paddingVertical:2,
    borderWidth:1, borderColor:'rgba(100,160,220,0.3)',
  },
  timerBadgeText:{ color:'#88AACC', fontSize:9, fontWeight:'800', letterSpacing:0.5 },
  distrBadge:{
    backgroundColor:'rgba(239,83,80,0.12)',
    borderRadius:6, paddingHorizontal:7, paddingVertical:2,
    borderWidth:1, borderColor:'rgba(239,83,80,0.3)',
  },
  distrBadgeText:{ color:'#EF5350', fontSize:9, fontWeight:'800', letterSpacing:0.5 },
  lvlName:{ fontSize:17, fontWeight:'800', letterSpacing:0.3 },
  lvlSubInfo:{ fontSize:11, fontWeight:'500', letterSpacing:0.3 },
  hsRow:{ flexDirection:'row', alignItems:'center', gap:5, marginTop:8, paddingTop:8, borderTopWidth:1, borderTopColor:'rgba(70,38,12,0.4)' },
  hsTrophy:{ fontSize:11 },
  hsVal:{ color:'#D4A040', fontSize:12, fontWeight:'800', letterSpacing:0.5 },
  lvlArrow:{ justifyContent:'center', paddingHorizontal:14 },
  lvlArrowText:{ fontSize:28, fontWeight:'300' },

  // ── Credits block
  creditsBox:{ width:'100%', alignItems:'center', paddingVertical:24, marginTop:8 },
  creditsDivRow:{ flexDirection:'row', alignItems:'center', gap:10, width:140, marginBottom:14 },
  creditsDivLine:{ flex:1, height:1, backgroundColor:'#2A1408' },
  creditsDivDot:{ color:'#4A2810', fontSize:7 },
  creditsTitle:{ color:'#3E2010', fontSize:8, fontWeight:'900', letterSpacing:4, marginBottom:12 },
  creditsLine:{ marginBottom:4 },
  creditsLabel:{ color:'#5A3520', fontSize:12 },
  creditsName:{ color:'#A86C38', fontSize:12, fontWeight:'800' },

  // ── Game HUD header
  gameHud:{
    flexDirection:'row', alignItems:'center', justifyContent:'space-between',
    paddingHorizontal:16, paddingVertical:10,
    borderBottomWidth:1, borderBottomColor:'rgba(60,30,8,0.6)',
    backgroundColor:'rgba(6,3,1,0.5)',
  },
  hudBack:{ flexDirection:'row', alignItems:'center', gap:2, padding:4 },
  hudBackIcon:{ color:'#5A3820', fontSize:24, lineHeight:26, marginTop:-2 },
  hudBackText:{ color:'#5A3820', fontSize:10, fontWeight:'900', letterSpacing:2 },
  hudCenter:{ alignItems:'center' },
  hudLevelEmoji:{ fontSize:16, marginBottom:1 },
  hudLevelName:{ color:'#C47840', fontSize:12, fontWeight:'900', letterSpacing:2.5 },
  hudScore:{
    alignItems:'center', minWidth:60,
    backgroundColor:'rgba(30,15,4,0.9)',
    borderRadius:12, paddingHorizontal:10, paddingVertical:6,
    borderWidth:1, borderColor:'rgba(90,50,10,0.5)',
  },
  hudScoreNum:{ color:'#FFD040', fontSize:19, fontWeight:'900', letterSpacing:0.5 },
  hudScoreLbl:{ color:'#4A2E10', fontSize:7, fontWeight:'900', letterSpacing:2.5 },

  // ── Stats row (below HUD)
  statsRow:{
    flexDirection:'row', alignItems:'center', paddingHorizontal:14,
    paddingVertical:8, gap:10,
    borderBottomWidth:1, borderBottomColor:'rgba(40,20,5,0.5)',
  },
  comboBadge:{
    backgroundColor:'rgba(255,100,40,0.15)', borderRadius:20,
    paddingHorizontal:10, paddingVertical:4,
    borderWidth:1, borderColor:'rgba(255,100,40,0.35)',
    minWidth:60, alignItems:'center',
  },
  comboTxt:{ color:'#FF6A30', fontSize:12, fontWeight:'900' },
  comboBadgeDim:{
    borderRadius:20, paddingHorizontal:10, paddingVertical:4,
    borderWidth:1, borderColor:'rgba(60,35,10,0.2)', minWidth:60, alignItems:'center',
  },
  comboDimTxt:{ color:'#2E1808', fontSize:12, fontWeight:'700' },

  // Progress pill
  pullProgress:{ flex:1, alignItems:'center', gap:4 },
  pullProgressTrack:{
    width:'100%', height:6,
    backgroundColor:'rgba(40,20,6,0.9)',
    borderRadius:3, overflow:'hidden',
    borderWidth:1, borderColor:'rgba(70,40,10,0.4)',
  },
  pullProgressFill:{
    height:'100%', borderRadius:3,
    backgroundColor:'#C87A30',
  },
  pullProgressLabel:{ color:'#7A5030', fontSize:10, fontWeight:'800', letterSpacing:1 },

  // Timer
  timerPill:{
    backgroundColor:'rgba(30,15,4,0.9)', borderRadius:12,
    paddingHorizontal:10, paddingVertical:5,
    borderWidth:1, borderColor:'rgba(70,40,10,0.4)',
    minWidth:60, alignItems:'center',
  },
  timerPillDanger:{
    backgroundColor:'rgba(80,5,5,0.9)',
    borderColor:'rgba(220,50,50,0.6)',
  },
  timerTxt:{ color:'#C4844A', fontSize:12, fontWeight:'900', letterSpacing:0.5 },
  timerTxtDanger:{ color:'#FF4444' },
  timerPillDim:{
    borderRadius:12, paddingHorizontal:10, paddingVertical:5,
    borderWidth:1, borderColor:'rgba(50,25,6,0.2)', minWidth:60, alignItems:'center',
  },
  timerDimTxt:{ color:'#2E1808', fontSize:14, fontWeight:'300' },

  // Hint bar
  hintRow:{ alignItems:'center', paddingVertical:6 },
  hintTxt:{
    color:'#684828', fontSize:11, letterSpacing:0.5,
    backgroundColor:'rgba(14,7,2,0.8)',
    paddingHorizontal:16, paddingVertical:5,
    borderRadius:20, overflow:'hidden',
    borderWidth:1, borderColor:'rgba(60,35,8,0.25)',
  },

  // Tower area
  towerArea:{ flexGrow:1, alignItems:'center', justifyContent:'flex-end', paddingVertical:8 },
  scorePopup:{
    fontSize:30, fontWeight:'900',
    textShadowColor:'rgba(0,0,0,0.95)',
    textShadowOffset:{ width:0, height:2 },
    textShadowRadius:10,
  },

  // Distraction Banner
  distrBanner:{
    backgroundColor:'rgba(6,3,0,0.99)', borderRadius:20,
    padding:22, borderWidth:2, borderColor:'#FF5722',
    alignItems:'center', minWidth:260, maxWidth:310, elevation:20,
    shadowColor:'#FF5722', shadowOffset:{ width:0, height:0 },
    shadowOpacity:0.5, shadowRadius:20,
  },
  distrTitle:{ color:'#FF5722', fontSize:20, fontWeight:'900', marginBottom:5 },
  distrDesc:{ color:'#B06838', fontSize:13, textAlign:'center', lineHeight:19 },

  // Stability bar
  stabilityWrap:{
    paddingHorizontal:16, paddingBottom:18, paddingTop:10,
    borderTopWidth:1, borderTopColor:'rgba(50,25,6,0.5)',
  },
  stabilityHeader:{
    flexDirection:'row', justifyContent:'space-between',
    alignItems:'center', marginBottom:8,
  },
  stabilityLabel:{ color:'#4A2E14', fontSize:9, fontWeight:'900', letterSpacing:2.5 },
  stabilityPct:{ fontSize:11, fontWeight:'900', letterSpacing:1 },
  stabilityTrack:{
    width:'100%', height:8,
    backgroundColor:'rgba(30,15,4,0.9)',
    borderRadius:4, overflow:'visible',
    borderWidth:1, borderColor:'rgba(60,30,8,0.4)',
    position:'relative',
  },
  stabilityFill:{ height:'100%', borderRadius:4, position:'absolute', left:0, top:0, bottom:0 },
  stabilityTick:{
    position:'absolute', top:-2, bottom:-2, width:1,
    backgroundColor:'rgba(0,0,0,0.3)',
  },
  dangerText:{
    color:'#FF4444', fontSize:11, fontWeight:'900',
    textAlign:'center', marginTop:7, letterSpacing:1.5,
  },

  // Result screen
  resWrap:{ flex:1, alignItems:'center', justifyContent:'center', padding:26 },
  resIconWrap:{ marginBottom:14 },
  resIconRing:{
    width:110, height:110, borderRadius:55,
    borderWidth:2, alignItems:'center', justifyContent:'center',
    backgroundColor:'rgba(255,255,255,0.03)',
  },
  resIcon:{ fontSize:56 },
  resTitle:{ fontSize:30, fontWeight:'900', letterSpacing:2.5, marginBottom:5 },
  resSubtitle:{ fontSize:13, fontWeight:'600', letterSpacing:1, marginBottom:26, opacity:0.7 },
  scoreCard:{
    width:'100%', backgroundColor:'rgba(255,255,255,0.04)',
    borderRadius:18, padding:18, marginBottom:26, borderWidth:1,
  },
  scoreCardRow:{ flexDirection:'row', justifyContent:'space-between', alignItems:'center', paddingVertical:7 },
  scoreCardDivider:{ height:1, backgroundColor:'rgba(255,255,255,0.06)', marginVertical:2 },
  newHighRow:{ backgroundColor:'rgba(255,215,0,0.07)', borderRadius:10, paddingHorizontal:10 },
  newHighLabel:{ color:'#FFD700', fontSize:12, fontWeight:'800', letterSpacing:0.5 },
  newHighVal:{ color:'#FFD700', fontSize:18, fontWeight:'900' },
  sk:{ color:'#4A4A4A', fontSize:13 },
  sv:{ color:'#C8C8C8', fontSize:16, fontWeight:'800' },
  resBtn:{
    width:'100%', paddingVertical:17, borderRadius:15,
    alignItems:'center', marginBottom:10, elevation:4, borderWidth:1,
  },
  resBtnPrimary:{ backgroundColor:'#4A2010', borderColor:'#7E3A18' },
  resBtnNext:{ backgroundColor:'#0C2C12', borderColor:'#1C5C28' },
  resBtnMenu:{ backgroundColor:'rgba(14,7,2,0.6)', borderColor:'rgba(60,35,10,0.3)' },
  rbt:{ color:'#E0B880', fontSize:14, fontWeight:'900', letterSpacing:3 },

  // Older style aliases (kept for compatibility)
  backBtn:{ flexDirection:'row', alignItems:'center', gap:2, padding:4 },
  backArrow:{ color:'#5A3820', fontSize:22, lineHeight:24, marginTop:-2 },
  backTxt:{ color:'#5A3820', fontSize:10, fontWeight:'800', letterSpacing:1.5 },
  hdr:{
    flexDirection:'row', alignItems:'center', justifyContent:'space-between',
    paddingHorizontal:14, paddingVertical:10,
    borderBottomWidth:1, borderBottomColor:'rgba(60,30,8,0.6)',
  },
  hdrCenter:{ alignItems:'center' },
  hdrEmoji:{ fontSize:15, marginBottom:1 },
  hdrName:{ color:'#C47840', fontSize:12, fontWeight:'900', letterSpacing:2.5 },
  scorePill:{
    alignItems:'center', minWidth:56,
    backgroundColor:'rgba(25,12,3,0.9)',
    borderRadius:12, paddingHorizontal:10, paddingVertical:5,
    borderWidth:1, borderColor:'rgba(80,45,10,0.45)',
  },
  scoreN:{ color:'#FFD040', fontSize:18, fontWeight:'900', letterSpacing:0.5 },
  scoreL:{ color:'#4A2E10', fontSize:7, fontWeight:'900', letterSpacing:2.5 },
  metricsRow:{
    flexDirection:'row', alignItems:'center', paddingHorizontal:12,
    paddingVertical:8, gap:8,
  },
  metricSlot:{ alignItems:'center' },
  progressTrack:{
    flex:1, height:22, backgroundColor:'rgba(30,15,4,0.9)',
    borderRadius:11, overflow:'hidden', justifyContent:'center',
    borderWidth:1, borderColor:'rgba(70,40,10,0.35)',
  },
  progressFill:{ position:'absolute', left:0, top:0, bottom:0, borderRadius:11, opacity:0.65 },
  progressTxt:{ textAlign:'center', color:'#906030', fontSize:11, fontWeight:'900', letterSpacing:1, zIndex:1 },
  timerPillWarn:{ backgroundColor:'rgba(70,0,0,0.8)', borderColor:'rgba(220,60,60,0.6)' },
  hintWrap:{ alignItems:'center', paddingVertical:5 },
  hintPill:{
    backgroundColor:'rgba(12,6,1,0.9)', borderRadius:20,
    paddingHorizontal:16, paddingVertical:6,
    borderWidth:1, borderColor:'rgba(60,35,8,0.25)',
  },
  stabWrap:{
    paddingHorizontal:16, paddingBottom:18, paddingTop:10,
    borderTopWidth:1, borderTopColor:'rgba(50,25,6,0.5)',
  },
  stabTop:{ flexDirection:'row', justifyContent:'space-between', marginBottom:8 },
  stabLbl:{ color:'#4A2E14', fontSize:9, fontWeight:'900', letterSpacing:2.5 },
  stabPct:{ fontSize:11, fontWeight:'900', letterSpacing:1 },
  stabTrack:{ flexDirection:'row', gap:3, height:8 },
  stabSeg:{ flex:1, height:8, borderRadius:4 },
  dangerBanner:{
    marginTop:8, backgroundColor:'rgba(70,0,0,0.45)',
    borderRadius:8, paddingVertical:5,
    borderWidth:1, borderColor:'rgba(220,60,60,0.4)',
  },
  dangerTxt:{
    color:'#EF5350', fontSize:11, fontWeight:'900',
    textAlign:'center', letterSpacing:2,
  },
});
