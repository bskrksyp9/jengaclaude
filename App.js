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

const { width: SW, height: SH } = Dimensions.get('window');

// ── Tower dimensions ──────────────────────────────────────────────────────────
const COLS    = 3;
const TOWER_W = Math.floor(SW * 0.72);   // narrower so tower fits with ISO depth
const BW      = Math.floor(TOWER_W / 3);
const BH      = Math.floor(BW * 0.32);   // slightly flatter = more Jenga-like ratio
const GAP     = 1;
const ROW_H   = BH + GAP;
const ISO_X   = Math.floor(BW * 0.28);   // deeper side face = stronger 3D
const ISO_Y   = Math.floor(BH * 0.70);   // taller top face

// ── Wood palette — much more varied colors so blocks look different ────────────
// Alternates light/dark rows, gives visible contrast between layers
const WOOD = [
  { top:'#E8A84C', side:'#7A4410', front:'#C07830' }, // warm amber
  { top:'#C87830', side:'#5C3008', front:'#A06020' }, // dark mahogany
  { top:'#DDA050', side:'#724010', front:'#B46828' }, // mid honey
  { top:'#BA6C28', side:'#502C08', front:'#8E5418' }, // deep brown
  { top:'#EAB060', side:'#844C14', front:'#C88038' }, // light pine
  { top:'#C47428', side:'#583008', front:'#9C5C20' }, // walnut
];

function br(slot, n) {
  const v = Math.sin(slot * 127.1 + n * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

// ── Levels — difficulty multipliers ──────────────────────────────────────────
// tiltMul:      how much each pull tilts the tower
// stabMul:      how fast stability drains
// collapseMul:  random collapse chance scaling
// tiltLimit:    max tilt degrees before instant collapse
// stabFloor:    minimum stability drain per pull (guarantees game ends)
const LEVELS = [
  { id:1, rows:9,  label:'Beginner',    emoji:'🪵', target:5,  timeLimit:0,   distrChance:0,    tiltMul:0.22, stabMul:0.28, collapseMul:0.12, tiltLimit:32, stabFloor:4  },
  { id:2, rows:12, label:'Casual',      emoji:'🏗️', target:8,  timeLimit:0,   distrChance:0,    tiltMul:0.40, stabMul:0.55, collapseMul:0.35, tiltLimit:28, stabFloor:7  },
  { id:3, rows:15, label:'Challenging', emoji:'😤', target:11, timeLimit:150, distrChance:0.25, tiltMul:0.60, stabMul:0.72, collapseMul:0.58, tiltLimit:24, stabFloor:10 },
  { id:4, rows:18, label:'Expert',      emoji:'🔥', target:14, timeLimit:100, distrChance:0.45, tiltMul:0.80, stabMul:0.88, collapseMul:0.78, tiltLimit:22, stabFloor:13 },
  { id:5, rows:21, label:'Master',      emoji:'💀', target:17, timeLimit:70,  distrChance:0.65, tiltMul:1.00, stabMul:1.00, collapseMul:1.00, tiltLimit:20, stabFloor:16 },
];

const LEVEL_ACCENT = ['#C87941','#B8682E','#A85820','#984818','#883810'];
const DIFF_TAGS    = ['EASY','CASUAL','MEDIUM','HARD','EXTREME'];

// ── Sound ─────────────────────────────────────────────────────────────────────
async function playTone(freq, duration, type = 'sine', volume = 0.3) {
  try {
    const { sound } = await Audio.Sound.createAsync(
      { uri: `data:audio/wav;base64,${generateWav(freq, duration, volume)}` },
      { shouldPlay: true, volume }
    );
    setTimeout(() => sound.unloadAsync(), duration + 200);
  } catch (e) {}
}
function generateWav(freq, durationMs, vol = 0.3) {
  const sr = 8000, n = Math.floor(sr * durationMs / 1000);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const ws = (o, s) => { for (let i=0;i<s.length;i++) v.setUint8(o+i,s.charCodeAt(i)); };
  ws(0,'RIFF'); v.setUint32(4,36+n*2,true); ws(8,'WAVE'); ws(12,'fmt ');
  v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,sr,true); v.setUint32(28,sr*2,true); v.setUint16(32,2,true);
  v.setUint16(34,16,true); ws(36,'data'); v.setUint32(40,n*2,true);
  for (let i=0;i<n;i++) {
    const t=i/sr, env=Math.min(1,t*20)*Math.max(0,1-t*(1000/durationMs)*0.8);
    v.setInt16(44+i*2,Math.max(-32767,Math.min(32767,Math.sin(2*Math.PI*freq*t)*env*vol*32767)),true);
  }
  let b=''; const bytes=new Uint8Array(buf);
  for (let i=0;i<bytes.byteLength;i++) b+=String.fromCharCode(bytes[i]);
  return btoa(b);
}
const SoundFX = {
  async select()   { Haptics.selectionAsync(); await playTone(440,80); },
  async pull()     { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); await playTone(220,150); await playTone(180,100); },
  async creak()    { Vibration.vibrate([0,30,15,30]); await playTone(80,200,'sawtooth',0.15); },
  async crash()    { Vibration.vibrate([0,100,50,200,50,300]); await playTone(60,300,undefined,0.4); await playTone(40,500,undefined,0.4); },
  async win()      { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); await playTone(523,100); await playTone(659,100); await playTone(784,200); },
  async distract() { Vibration.vibrate([0,40,20,40]); await playTone(300,120); },
  async danger()   { await playTone(110,300,'sawtooth',0.2); },
  async tick()     { await playTone(800,50,undefined,0.1); },
};

// ── Game logic ────────────────────────────────────────────────────────────────
function buildTower(rows) {
  return Array.from({length:rows},(_,r)=>
    Array.from({length:COLS},(_,c)=>({
      id:`${r}-${c}`,row:r,col:c,removed:false,
      // Alternate light/dark every row — strong visual layering
      // Even rows light, odd rows dark, with slight col variation
      wood: (r % 2 === 0)
        ? [0, 2, 4][c % 3]   // light variants: amber, honey, pine
        : [1, 3, 5][c % 3],  // dark variants: mahogany, brown, walnut
      ox:(Math.random()-0.5)*1.2, oy:(Math.random()-0.5)*0.6,
    }))
  );
}
function getTopRow(tower) {
  for (let r=tower.length-1;r>=0;r--) if(tower[r].some(b=>!b.removed)) return r;
  return 0;
}
function canRemove(block, tower) {
  if (block.removed) return false;
  if (block.row >= getTopRow(tower)-1) return false;
  return tower[block.row].filter(b=>!b.removed).length > 1;
}
function getInstabilityScore(block, tower) {
  const remaining = tower[block.row].filter(b=>!b.removed&&b.id!==block.id);
  let unsupported = 0;
  for (const ar of tower.slice(block.row+1)) unsupported += ar.filter(b=>!b.removed).length;
  // Last block in a row — pulling middle col is worst case
  if (remaining.length===1 && block.col===1) return 0.70;
  // Last edge block in a row
  if (remaining.length===1) return 0.45;
  // Safe center block, 2 others still present
  if (block.col===1 && remaining.length===2) return 0.05;
  // Edge block, 2 others still present — slightly risky
  return 0.18 + (unsupported/(tower.length*3))*0.12;
}

// ── Block renderer ────────────────────────────────────────────────────────────
function IsoBlock({ x, y, w, h, wood, isSelected, isRemovable, dimmed, slot }) {
  const { top:ct, side:cs, front:cf } = WOOD[wood];
  const ix=ISO_X, iy=ISO_Y, sl=slot||0;

  // Per-corner warp
  const wp=h*0.07;
  const w00=(br(sl,0)-0.5)*wp, w10=(br(sl,1)-0.5)*wp;
  const w01=(br(sl,2)-0.5)*wp, w11=(br(sl,3)-0.5)*wp;

  const tx0=x,     ty0=y+w00;
  const tx1=x+w,   ty1=y+w10;
  const tx2=x+w+ix,ty2=y-iy+w11;
  const tx3=x+ix,  ty3=y-iy+w01;

  const topPts  =`${tx0},${ty0} ${tx1},${ty1} ${tx2},${ty2} ${tx3},${ty3}`;
  const frtPts  =`${tx0},${ty0} ${tx1},${ty1} ${x+w},${y+h} ${x},${y+h}`;
  const sidPts  =`${tx1},${ty1} ${tx2},${ty2} ${x+w+ix},${y-iy+h} ${x+w},${y+h}`;
  const op      = dimmed ? 0.32 : 1;
  const sel     = isSelected;
  const grains  = [0.16,0.31,0.50,0.68,0.83];

  return (
    <G opacity={op}>
      {/* shadow */}
      <Polygon points={`${x+4},${y+h+2} ${x+w+4},${y+h+2} ${x+w+ix+4},${y-iy+h+2} ${x+ix+4},${y-iy+h+2}`} fill="rgba(0,0,0,0.18)" />

      {/* front */}
      <Polygon points={frtPts} fill={cf} stroke={sel?'#FFD700':'rgba(0,0,0,0.55)'} strokeWidth={sel?1.8:0.6} />
      {grains.map((t,i)=>(
        <Line key={`f${i}`} x1={x+w*t} y1={y+h} x2={x+w*t+(br(sl,20+i)-0.5)*2} y2={y}
          stroke={br(sl,30+i)>0.5?'rgba(0,0,0,0.18)':'rgba(255,255,255,0.10)'}
          strokeWidth={0.6+br(sl,40+i)*0.9} />
      ))}
      <Line x1={x} y1={y} x2={x} y2={y+h} stroke="rgba(255,255,255,0.12)" strokeWidth={1.8}/>
      <Line x1={x} y1={y+h} x2={x+w} y2={y+h} stroke="rgba(0,0,0,0.35)" strokeWidth={1.0}/>

      {/* side */}
      <Polygon points={sidPts} fill={cs} stroke={sel?'#FFD700':'rgba(0,0,0,0.52)'} strokeWidth={sel?1.8:0.5} />
      <Polygon points={sidPts} fill="rgba(0,0,0,0.09)" />

      {/* top */}
      <Polygon points={topPts} fill={ct} stroke={sel?'#FFD700':'rgba(0,0,0,0.16)'} strokeWidth={sel?1.8:0.4} />
      {grains.map((t,i)=>(
        <Line key={`t${i}`}
          x1={x+w*t} y1={y+w00+(w10-w00)*t}
          x2={x+w*t+ix} y2={y+w00+(w10-w00)*t-iy}
          stroke={br(sl,50+i)>0.5?'rgba(0,0,0,0.09)':'rgba(255,255,255,0.06)'}
          strokeWidth={0.5+br(sl,60+i)*0.5} />
      ))}
      {/* top highlight */}
      <Polygon points={`${tx0+1},${ty0-1} ${tx0+w*0.4},${ty0-1} ${tx0+w*0.4+ix*0.4},${ty0-iy*0.4-1} ${tx0+ix*0.4},${ty0-iy*0.4-1}`} fill="rgba(255,255,255,0.12)" />

      {/* knot */}
      {(()=>{
        const kx=x+w*(0.15+br(sl,70)*0.65)+ix*(0.15+br(sl,71)*0.35);
        const ky=y-iy*(0.2+br(sl,72)*0.55)+(br(sl,73)-0.3)*h*0.4;
        const kr=h*(0.18+br(sl,74)*0.16);
        return(<>
          <Polygon points={`${kx-kr*0.8},${ky} ${kx},${ky-kr*0.5} ${kx+kr*0.8},${ky} ${kx},${ky+kr*0.8}`} fill={cs} opacity={0.55}/>
          <Polygon points={`${kx-kr*0.4},${ky} ${kx},${ky-kr*0.25} ${kx+kr*0.4},${ky} ${kx},${ky+kr*0.4}`} fill="rgba(0,0,0,0.18)" opacity={0.55}/>
          {br(sl,75)>0.5&&<Polygon points={`${kx+w*0.28-kr*0.6},${ky-iy*0.2} ${kx+w*0.28},${ky-iy*0.2-kr*0.4} ${kx+w*0.28+kr*0.6},${ky-iy*0.2} ${kx+w*0.28},${ky-iy*0.2+kr*0.6}`} fill={cs} opacity={0.35}/>}
        </>);
      })()}

      {sel&&<><Polygon points={topPts} fill="rgba(255,215,0,0.20)"/><Polygon points={frtPts} fill="rgba(255,215,0,0.08)"/><Polygon points={sidPts} fill="rgba(255,215,0,0.06)"/></>}
      {isRemovable&&!sel&&<Polygon points={topPts} fill="rgba(255,220,130,0.08)"/>}
    </G>
  );
}

// ── Tower view ────────────────────────────────────────────────────────────────
function TowerView({ tower, selected, setSelected, onPullBlock, tiltAnim, shakeAnim, wobbleAnim, scaleAnim }) {
  const rows=tower.length, svgW=SW-8, svgH=rows*ROW_H+ISO_Y+70;
  const startX=(svgW-COLS*BW-ISO_X)/2;
  const dragRef=useRef({blockId:null,dx:0,pulling:false});
  const dragAnims=useRef({});

  const createPR=useCallback((block)=>{
    if(!canRemove(block,tower)) return {panHandlers:{}};
    return PanResponder.create({
      onStartShouldSetPanResponder:()=>true,
      onMoveShouldSetPanResponder:(_,g)=>Math.abs(g.dx)>4,
      onPanResponderGrant:()=>{
        SoundFX.select(); setSelected(block);
        dragRef.current={blockId:block.id,dx:0,pulling:false};
        if(!dragAnims.current[block.id]) dragAnims.current[block.id]=new Animated.Value(0);
      },
      onPanResponderMove:(_,g)=>{
        dragRef.current.dx=g.dx;
        dragAnims.current[block.id]?.setValue(g.dx);
        if(Math.abs(g.dx)>18&&!dragRef.current.pulling){dragRef.current.pulling=true;SoundFX.creak();}
      },
      onPanResponderRelease:(_,g)=>{
        const anim=dragAnims.current[block.id], thr=BW*0.65;
        if(Math.abs(g.dx)>=thr){
          // Fly out fast with slight arc
          Animated.timing(anim,{toValue:g.dx>0?SW*1.2:-SW*1.2,duration:220,useNativeDriver:true})
            .start(()=>{
              anim?.setValue(0);
              delete dragAnims.current[block.id];
              onPullBlock(block,g.dx);
            });
        } else {
          // Snap back with bounce
          Animated.spring(anim,{toValue:0,tension:180,friction:7,useNativeDriver:true}).start();
          SoundFX.creak(); setSelected(null);
        }
        dragRef.current.pulling=false;
      },
      onPanResponderTerminate:()=>{
        Animated.spring(dragAnims.current[block.id],{toValue:0,tension:130,friction:8,useNativeDriver:true}).start();
        setSelected(null);
      },
    });
  },[tower,setSelected,onPullBlock]);

  const visible=tower.flat().filter(b=>!b.removed).sort((a,b)=>a.row-b.row||a.col-b.col);

  return (
    <Animated.View style={{width:svgW,height:svgH,transform:[
      {rotate:tiltAnim.interpolate({inputRange:[-92,92],outputRange:['-92deg','92deg']})},
      {translateX:shakeAnim},
      {translateX:wobbleAnim},
      {scale:scaleAnim},
    ],alignSelf:'center',transformOrigin:'bottom'}}>
      <Svg width={svgW} height={svgH} style={StyleSheet.absoluteFill} pointerEvents="none">
        {/* floor shadow */}
        {[0.9,0.65,0.4].map((s,i)=>(
          <Polygon key={i}
            points={`${startX+BW*0.1*(1-s)},${svgH-20+i*2} ${startX+COLS*BW+ISO_X-BW*0.1*(1-s)},${svgH-20+i*2} ${startX+COLS*BW+ISO_X-BW*0.1*(1-s)},${svgH-18+i*2} ${startX+BW*0.1*(1-s)},${svgH-18+i*2}`}
            fill={`rgba(0,0,0,${0.07*s})`}/>
        ))}
        {visible.map(block=>{
          const {row,col,wood,ox,oy}=block;
          const bx=startX+col*BW+ox, by=svgH-22-row*ROW_H-BH+oy, slot=row*COLS+col;
          return(
            <IsoBlock key={block.id} x={bx} y={by} w={BW} h={BH} wood={wood}
              isSelected={selected?.id===block.id} isRemovable={canRemove(block,tower)}
              dimmed={!!selected&&selected.id!==block.id&&!canRemove(block,tower)} slot={slot}/>
          );
        })}
      </Svg>
      {visible.map(block=>{
        const {col,row,ox,oy}=block;
        const bx=startX+col*BW+ox, by=svgH-22-row*ROW_H-BH+oy;
        const pr=canRemove(block,tower)?createPR(block):null;
        const anim=dragAnims.current[block.id]||new Animated.Value(0);
        return(
          <Animated.View key={`t-${block.id}`} {...(pr?pr.panHandlers:{})}
            style={{position:'absolute',left:bx,top:by-ISO_Y,width:BW+ISO_X,height:BH+ISO_Y,transform:[{translateX:anim}]}}/>
        );
      })}
    </Animated.View>
  );
}

// ── Distraction banner ────────────────────────────────────────────────────────
function DistractionBanner({ distraction }) {
  const a=useRef(new Animated.Value(0)).current;
  useEffect(()=>{
    Animated.sequence([
      Animated.spring(a,{toValue:1,tension:70,friction:6,useNativeDriver:true}),
      Animated.delay(2000),
      Animated.timing(a,{toValue:0,duration:400,useNativeDriver:true}),
    ]).start();
  },[distraction?.id]);
  if(!distraction) return null;
  return(
    <Animated.View style={[S.distrBanner,{opacity:a,transform:[{scale:a.interpolate({inputRange:[0,1],outputRange:[0.7,1]})}]}]}>
      <Text style={S.distrTitle}>{distraction.icon} {distraction.label}</Text>
      <Text style={S.distrDesc}>{distraction.desc}</Text>
    </Animated.View>
  );
}

// ── Score popup ───────────────────────────────────────────────────────────────
function ScorePopup({ score, color, onDone }) {
  const y=useRef(new Animated.Value(0)).current, op=useRef(new Animated.Value(1)).current;
  useEffect(()=>{
    Animated.parallel([
      Animated.timing(y,{toValue:-65,duration:900,useNativeDriver:true}),
      Animated.sequence([Animated.delay(380),Animated.timing(op,{toValue:0,duration:520,useNativeDriver:true})]),
    ]).start(()=>onDone?.());
  },[]);
  return <Animated.Text style={[S.scorePopup,{color,opacity:op,transform:[{translateY:y}]}]}>+{score}</Animated.Text>;
}

// ── Menu screen ───────────────────────────────────────────────────────────────
function MenuScreen({ onStart, unlockedLevels, highScores }) {
  const fade=useRef(new Animated.Value(0)).current, slide=useRef(new Animated.Value(24)).current;
  useEffect(()=>{
    Animated.parallel([
      Animated.timing(fade,{toValue:1,duration:600,useNativeDriver:true}),
      Animated.spring(slide,{toValue:0,tension:60,friction:10,useNativeDriver:true}),
    ]).start();
  },[]);
  return(
    <LinearGradient colors={['#0C0501','#160803','#1E0D05','#170A03']} style={S.root}>
      <SafeAreaView style={S.safe}>
        <ScrollView contentContainerStyle={S.menuScroll} showsVerticalScrollIndicator={false}>

          <Animated.View style={[S.heroBox,{opacity:fade,transform:[{translateY:slide}]}]}>
            <View style={S.logoRing}><Text style={{fontSize:30}}>🪵</Text></View>
            <Text style={S.logo}>JENGA</Text>
            <View style={S.divRow}><View style={S.divLine}/><Text style={S.divDot}>◆</Text><View style={S.divLine}/></View>
            <Text style={S.logoSub}>DRAG · PULL · SURVIVE</Text>
          </Animated.View>

          <Animated.View style={[S.howBox,{opacity:fade}]}>
            <View style={S.howHeader}>
              <View style={S.howLine}/><Text style={S.howTitle}>HOW TO PLAY</Text><View style={S.howLine}/>
            </View>
            {[['👈','Swipe a block left or right to pull it out'],['⚡','Must drag past 65% — short swipe snaps back'],['🎯','Center blocks safe · Edge blocks are risky'],['☠️','Last 2 in a row? Pull the middle = collapse!']].map(([icon,text],i)=>(
              <View key={i} style={S.howRow}><Text style={S.howIcon}>{icon}</Text><Text style={S.howText}>{text}</Text></View>
            ))}
          </Animated.View>

          <View style={S.secRow}><View style={S.secLine}/><Text style={S.secLabel}>SELECT LEVEL</Text><View style={S.secLine}/></View>

          {LEVELS.map((lvl,i)=>{
            const locked=!unlockedLevels.includes(i), hs=highScores[i]||0, ac=LEVEL_ACCENT[i];
            return(
              <TouchableOpacity key={lvl.id} style={[S.lvlCard,locked&&S.lvlCardLocked]} disabled={locked} onPress={()=>onStart(i)} activeOpacity={0.80}>
                <View style={[S.lvlStripe,{backgroundColor:locked?'#1E0E04':ac}]}/>
                <Text style={S.lvlEmoji}>{locked?'🔒':lvl.emoji}</Text>
                <View style={{flex:1,paddingVertical:14,paddingRight:4}}>
                  <View style={{flexDirection:'row',gap:6,marginBottom:4}}>
                    <View style={[S.diffBadge,{borderColor:locked?'#2A1408':ac+'55',backgroundColor:locked?'transparent':ac+'18'}]}>
                      <Text style={[S.diffBadgeTxt,{color:locked?'#2A1408':ac}]}>{DIFF_TAGS[i]}</Text>
                    </View>
                    {lvl.timeLimit>0&&!locked&&<View style={S.timeBadge}><Text style={S.timeBadgeTxt}>⏱ {lvl.timeLimit}s</Text></View>}
                    {lvl.distrChance>0&&!locked&&<View style={S.chaosBadge}><Text style={S.chaosBadgeTxt}>💥 CHAOS</Text></View>}
                  </View>
                  <Text style={[S.lvlName,{color:locked?'#2E1608':'#DFA060'}]}>{lvl.label}</Text>
                  <Text style={[S.lvlMeta,{color:locked?'#1E0E04':'#5A3818'}]}>{lvl.rows} rows · pull {lvl.target} blocks</Text>
                  {!locked&&hs>0&&(
                    <View style={{flexDirection:'row',alignItems:'center',gap:4,marginTop:6,paddingTop:6,borderTopWidth:1,borderTopColor:'rgba(80,40,10,0.28)'}}>
                      <Text style={{fontSize:10}}>🏆</Text><Text style={S.hsVal}>{hs.toLocaleString()}</Text>
                    </View>
                  )}
                </View>
                {!locked&&<Text style={[S.lvlArrow,{color:ac}]}>›</Text>}
              </TouchableOpacity>
            );
          })}

          <View style={S.creditsBox}>
            <View style={S.divRow}><View style={S.divLine}/><Text style={S.divDot}>◆</Text><View style={S.divLine}/></View>
            <Text style={S.creditsTitle}>CREDITS</Text>
            <Text style={S.creditsLine}><Text style={S.creditsLbl}>🎮 Game Dev  </Text><Text style={S.creditsName}>Claude</Text></Text>
            <Text style={S.creditsLine}><Text style={S.creditsLbl}>🧠 Prompt Engineer  </Text><Text style={S.creditsName}>Skarabhaa</Text></Text>
          </View>

        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

// ── Game screen ───────────────────────────────────────────────────────────────
function GameScreen({ levelIdx,tower,selected,setSelected,tiltAnim,shakeAnim,wobbleAnim,scaleAnim,removedCount,stability,score,combo,timeLeft,distraction,scorePopups,onPullBlock,onMenu,onPopupDone }) {
  const lvl=LEVELS[levelIdx];
  const sc=stability>60?'#4CCC6A':stability>30?'#F5C518':'#FF4444';
  const sb=stability>60?'rgba(76,204,106,0.08)':stability>30?'rgba(245,197,24,0.08)':'rgba(255,68,68,0.10)';
  const isTimed=lvl.timeLimit>0, tw=isTimed&&timeLeft<=15, prog=Math.min(1,removedCount/lvl.target);
  return(
    <LinearGradient colors={['#070300','#100602','#180A03']} style={S.root}>
      <SafeAreaView style={S.safe}>
        <View style={S.hud}>
          <TouchableOpacity onPress={onMenu} style={S.hudBack} activeOpacity={0.7}>
            <Text style={S.hudBackArrow}>‹</Text><Text style={S.hudBackTxt}>MENU</Text>
          </TouchableOpacity>
          <View style={{alignItems:'center'}}>
            <Text style={{fontSize:14}}>{lvl.emoji}</Text>
            <Text style={S.hudLevel}>{lvl.label.toUpperCase()}</Text>
          </View>
          <View style={S.hudScoreBox}>
            <Text style={S.hudScoreNum}>{score.toLocaleString()}</Text>
            <Text style={S.hudScoreLbl}>SCORE</Text>
          </View>
        </View>

        <View style={S.statsRow}>
          {combo>1?<View style={S.comboBadge}><Text style={S.comboTxt}>🔥 ×{combo}</Text></View>
                  :<View style={S.comboBlank}><Text style={S.comboBlankTxt}>×1</Text></View>}
          <View style={S.progWrap}>
            <View style={S.progTrack}><View style={[S.progFill,{width:`${prog*100}%`}]}/></View>
            <Text style={S.progLbl}>{removedCount} / {lvl.target}</Text>
          </View>
          {isTimed?<View style={[S.timerPill,tw&&S.timerDanger]}><Text style={[S.timerTxt,tw&&{color:'#FF4444'}]}>⏱{timeLeft}s</Text></View>
                  :<View style={S.timerBlank}><Text style={S.timerBlankTxt}>∞</Text></View>}
        </View>

        <View style={{alignItems:'center',paddingVertical:5}}>
          <Text style={S.hintTxt}>{selected?'← Drag left or right to pull →':'👆 Touch a block and drag sideways'}</Text>
        </View>

        <View style={{flex:1,overflow:'hidden'}}>
          <ScrollView contentContainerStyle={S.towerArea} showsVerticalScrollIndicator={false}>
            <TowerView tower={tower} selected={selected} setSelected={setSelected}
              onPullBlock={onPullBlock} tiltAnim={tiltAnim} shakeAnim={shakeAnim}
              wobbleAnim={wobbleAnim} scaleAnim={scaleAnim} levelIdx={levelIdx}/>
          </ScrollView>
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {scorePopups.map(p=>(
              <View key={p.id} style={[StyleSheet.absoluteFill,{justifyContent:'center',alignItems:'center'}]}>
                <ScorePopup score={p.score} color={p.color} onDone={()=>onPopupDone(p.id)}/>
              </View>
            ))}
          </View>
          <View style={[StyleSheet.absoluteFill,{justifyContent:'center',alignItems:'center'}]} pointerEvents="none">
            <DistractionBanner distraction={distraction}/>
          </View>
        </View>

        <View style={[S.stabWrap,{backgroundColor:sb}]}>
          <View style={{flexDirection:'row',justifyContent:'space-between',marginBottom:6}}>
            <Text style={S.stabLbl}>STRUCTURAL INTEGRITY</Text>
            <Text style={[S.stabPct,{color:sc}]}>{Math.round(stability)}%</Text>
          </View>
          <View style={S.stabTrack}>
            <Animated.View style={[S.stabFill,{width:`${stability}%`,backgroundColor:sc}]}/>
            {[25,50,75].map(t=><View key={t} style={[S.stabTick,{left:`${t}%`}]}/>)}
          </View>
          {stability<30&&<Text style={S.dangerTxt}>⚠️  CRITICAL — ONE WRONG MOVE</Text>}
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}

// ── Result screen ─────────────────────────────────────────────────────────────
function ResultScreen({ won,levelIdx,removedCount,score,highScore,isNewHigh,onReplay,onNext,onMenu }) {
  const a=useRef(new Animated.Value(0)).current, ia=useRef(new Animated.Value(0.4)).current;
  useEffect(()=>{
    Animated.parallel([
      Animated.spring(a,{toValue:1,tension:55,friction:7,useNativeDriver:true}),
      Animated.spring(ia,{toValue:1,tension:40,friction:5,delay:120,useNativeDriver:true}),
    ]).start();
  },[]);
  return(
    <LinearGradient colors={won?['#040E05','#081808','#0D220E']:['#0E0404','#1A0707','#260B0B']} style={S.root}>
      <SafeAreaView style={S.safe}>
        <Animated.View style={[S.resWrap,{opacity:a,transform:[{scale:a.interpolate({inputRange:[0,1],outputRange:[0.88,1]})}]}]}>
          <Animated.View style={{transform:[{scale:ia}],marginBottom:14}}>
            <View style={[S.resIconRing,{borderColor:won?'#4CCC6A44':'#FF444444'}]}>
              <Text style={S.resIcon}>{won?'🏆':'💥'}</Text>
            </View>
          </Animated.View>
          <Text style={[S.resTitle,{color:won?'#4CCC6A':'#FF4444'}]}>{won?'TOWER SURVIVED!':'TOWER FELL!'}</Text>
          <Text style={[S.resSub,{color:won?'#2A7A30':'#7A2020'}]}>{won?`Level ${levelIdx+1} Complete`:'Better luck next time'}</Text>
          <View style={[S.scoreCard,{borderColor:won?'#1A4A1A':'#4A1A1A'}]}>
            <View style={S.scoreRow}><Text style={S.sk}>Blocks Removed</Text><Text style={S.sv}>{removedCount}</Text></View>
            <View style={S.scoreDiv}/>
            <View style={S.scoreRow}><Text style={S.sk}>Score</Text><Text style={[S.sv,{color:'#FFD700',fontSize:20}]}>{score.toLocaleString()}</Text></View>
            {isNewHigh?(<><View style={S.scoreDiv}/><View style={[S.scoreRow,{backgroundColor:'rgba(255,215,0,0.07)',borderRadius:8,padding:6}]}><Text style={[S.sk,{color:'#FFD700'}]}>🌟 NEW BEST!</Text><Text style={[S.sv,{color:'#FFD700'}]}>{score.toLocaleString()}</Text></View></>)
              :highScore>0&&(<><View style={S.scoreDiv}/><View style={S.scoreRow}><Text style={S.sk}>Personal Best</Text><Text style={S.sv}>{highScore.toLocaleString()}</Text></View></>)}
          </View>
          <TouchableOpacity style={[S.resBtn,{backgroundColor:'#3E1C0A',borderColor:'#6E3218'}]} onPress={onReplay} activeOpacity={0.8}><Text style={S.rbt}>🔄  PLAY AGAIN</Text></TouchableOpacity>
          {won&&levelIdx+1<LEVELS.length&&<TouchableOpacity style={[S.resBtn,{backgroundColor:'#0A2210',borderColor:'#1A5228'}]} onPress={onNext} activeOpacity={0.8}><Text style={S.rbt}>NEXT LEVEL  ›</Text></TouchableOpacity>}
          <TouchableOpacity style={[S.resBtn,{backgroundColor:'rgba(12,6,1,0.6)',borderColor:'rgba(60,30,8,0.3)'}]} onPress={onMenu} activeOpacity={0.8}><Text style={[S.rbt,{color:'#5A3420'}]}>MAIN MENU</Text></TouchableOpacity>
        </Animated.View>
      </SafeAreaView>
    </LinearGradient>
  );
}

// ── Distractions ──────────────────────────────────────────────────────────────
const DISTRACTIONS_LIST=[
  {id:'wind',icon:'💨',label:'WIND GUST!',desc:'A sudden wind shakes the tower',
    effect:(tr,ta)=>{const p=(Math.random()>0.5?1:-1)*(5+Math.random()*6),nt=Math.max(-22,Math.min(22,tr.current+p));tr.current=nt;Animated.spring(ta,{toValue:nt,tension:25,friction:5,useNativeDriver:true}).start();}},
  {id:'quake',icon:'🌍',label:'MICRO-QUAKE!',desc:'The ground trembles briefly',
    effect:(tr,ta,sa)=>{Animated.sequence([Animated.timing(sa,{toValue:12,duration:60,useNativeDriver:true}),Animated.timing(sa,{toValue:-12,duration:60,useNativeDriver:true}),Animated.timing(sa,{toValue:8,duration:60,useNativeDriver:true}),Animated.timing(sa,{toValue:-8,duration:60,useNativeDriver:true}),Animated.timing(sa,{toValue:4,duration:60,useNativeDriver:true}),Animated.timing(sa,{toValue:0,duration:60,useNativeDriver:true})]).start();Vibration.vibrate([0,50,30,50,30,50]);}},
  {id:'bump',icon:'🤦',label:'TABLE BUMPED!',desc:'Someone bumped the table!',
    effect:(tr,ta,sa)=>{const p=(Math.random()>0.5?1:-1)*(3+Math.random()*4),nt=Math.max(-22,Math.min(22,tr.current+p));tr.current=nt;Animated.spring(ta,{toValue:nt,tension:30,friction:6,useNativeDriver:true}).start();Vibration.vibrate([0,80,40,80]);}},
  {id:'sneeze',icon:'🤧',label:'ACHOO!',desc:'Someone sneezed on the tower!',
    effect:(_,__,sa)=>{Animated.sequence([Animated.timing(sa,{toValue:8,duration:50,useNativeDriver:true}),Animated.timing(sa,{toValue:-8,duration:50,useNativeDriver:true}),Animated.timing(sa,{toValue:4,duration:50,useNativeDriver:true}),Animated.timing(sa,{toValue:0,duration:50,useNativeDriver:true})]).start();Vibration.vibrate([0,40,20,40]);}},
];

// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,setScreen]=useState('menu');
  const [levelIdx,setLevelIdx]=useState(0);
  const [tower,setTower]=useState([]);
  const [selected,setSelected]=useState(null);
  const [removedCount,setRemovedCount]=useState(0);
  const [stability,setStability]=useState(100);
  const [score,setScore]=useState(0);
  const [combo,setCombo]=useState(1);
  const [won,setWon]=useState(false);
  const [unlockedLevels,setUnlockedLevels]=useState([0]);
  const [highScores,setHighScores]=useState({});
  const [timeLeft,setTimeLeft]=useState(0);
  const [distraction,setDistraction]=useState(null);
  const [scorePopups,setScorePopups]=useState([]);

  const tiltAnim=useRef(new Animated.Value(0)).current;
  const shakeAnim=useRef(new Animated.Value(0)).current;
  const wobbleAnim=useRef(new Animated.Value(0)).current;  // continuous micro-sway
  const scaleAnim=useRef(new Animated.Value(1)).current;   // collapse scale-down
  const tiltVal=useRef(0), timerRef=useRef(null), distrRef=useRef(null);
  const comboRef=useRef(null), gameOverRef=useRef(false);
  const wobbleLoop=useRef(null);

  const cleanup=()=>{
    if(timerRef.current) clearInterval(timerRef.current);
    if(distrRef.current) clearInterval(distrRef.current);
    if(comboRef.current) clearTimeout(comboRef.current);
    if(wobbleLoop.current) wobbleLoop.current.stop();
  };

  // Start continuous micro-wobble based on stability
  const startWobble=useCallback((stab)=>{
    if(wobbleLoop.current) wobbleLoop.current.stop();
    const amp = Math.max(0, (100-stab)/100) * 2.5 + 0.3; // more wobble as stability drops
    const speed = 800 + stab * 6; // faster wobble when unstable
    wobbleLoop.current = Animated.loop(
      Animated.sequence([
        Animated.timing(wobbleAnim,{toValue:amp,duration:speed,useNativeDriver:true}),
        Animated.timing(wobbleAnim,{toValue:-amp,duration:speed,useNativeDriver:true}),
      ])
    );
    wobbleLoop.current.start();
  },[]);

  const triggerCollapse=useCallback((ct)=>{
    if(gameOverRef.current) return;
    gameOverRef.current=true; cleanup(); SoundFX.crash();
    Vibration.vibrate([0,80,40,120,60,200,80,300]);

    // Phase 1: violent shake
    Animated.sequence([
      Animated.timing(shakeAnim,{toValue:18,duration:60,useNativeDriver:true}),
      Animated.timing(shakeAnim,{toValue:-22,duration:60,useNativeDriver:true}),
      Animated.timing(shakeAnim,{toValue:16,duration:55,useNativeDriver:true}),
      Animated.timing(shakeAnim,{toValue:-18,duration:55,useNativeDriver:true}),
      Animated.timing(shakeAnim,{toValue:12,duration:50,useNativeDriver:true}),
      Animated.timing(shakeAnim,{toValue:-14,duration:50,useNativeDriver:true}),
      Animated.timing(shakeAnim,{toValue:0,duration:80,useNativeDriver:true}),
    ]).start();

    // Phase 2: tip over and shrink
    Animated.sequence([
      Animated.delay(180),
      Animated.parallel([
        Animated.timing(tiltAnim,{toValue:ct>0?92:-92,duration:700,useNativeDriver:true}),
        Animated.timing(scaleAnim,{toValue:0.85,duration:700,useNativeDriver:true}),
      ]),
      Animated.timing(scaleAnim,{toValue:0,duration:300,useNativeDriver:true}),
    ]).start();

    setWon(false);
    setTimeout(()=>setScreen('result'),1200);
  },[]);

  const startLevel=useCallback((idx)=>{
    cleanup(); gameOverRef.current=false;
    const cfg=LEVELS[idx];
    setLevelIdx(idx); setTower(buildTower(cfg.rows)); setSelected(null);
    tiltVal.current=0; tiltAnim.setValue(0); shakeAnim.setValue(0);
    setRemovedCount(0); setStability(100); setScore(0); setCombo(1);
    setWon(false); setDistraction(null); setScorePopups([]);
    wobbleAnim.setValue(0); scaleAnim.setValue(1);
    startWobble(100); // start gentle wobble
    if(cfg.timeLimit>0){
      setTimeLeft(cfg.timeLimit);
      timerRef.current=setInterval(()=>{
        setTimeLeft(prev=>{
          if(prev<=1){triggerCollapse(tiltVal.current);return 0;}
          if(prev<=10) SoundFX.tick();
          return prev-1;
        });
      },1000);
    }
    if(cfg.distrChance>0){
      const sched=()=>{
        distrRef.current=setTimeout(()=>{
          if(gameOverRef.current) return;
          if(Math.random()<cfg.distrChance){
            const d=DISTRACTIONS_LIST[Math.floor(Math.random()*DISTRACTIONS_LIST.length)];
            setDistraction(d); SoundFX.distract(); d.effect(tiltVal,tiltAnim,shakeAnim);
            setTimeout(()=>{if(Math.abs(tiltVal.current)>20) triggerCollapse(tiltVal.current);},800);
          }
          sched();
        },12000+Math.random()*10000);
      };
      sched();
    }
    setScreen('game');
  },[triggerCollapse]);

  useEffect(()=>()=>cleanup(),[]);

  const handlePullBlock=useCallback((block,dragDx)=>{
    if(gameOverRef.current) return;
    const cfg=LEVELS[levelIdx];
    SoundFX.pull(); setSelected(null);
    const newTower=tower.map(row=>row.map(b=>b.id===block.id?{...b,removed:true}:b));
    setTower(newTower);
    const newCount=removedCount+1; setRemovedCount(newCount);

    const instability=getInstabilityScore(block,tower);
    const rowHeight=block.row/cfg.rows;
    const pulledDir=dragDx>0?1:-1;

    // ── Tilt ─────────────────────────────────────────────────────────────────
    // Each pull tilts based on instability + row height, scaled by level
    const tiltDelta = (instability*5 + rowHeight*1.5 + 0.4) * cfg.tiltMul;
    const noise     = (Math.random()-0.5) * 0.6 * cfg.tiltMul;
    // Tower partially recenters between pulls (damping) — feels physical
    const damped    = tiltVal.current * 0.85;
    const newTilt   = Math.max(-cfg.tiltLimit, Math.min(cfg.tiltLimit,
      damped + pulledDir * tiltDelta + noise
    ));
    tiltVal.current = newTilt;
    Animated.spring(tiltAnim, {toValue:newTilt, tension:32, friction:7, useNativeDriver:true}).start();
    if (Math.abs(newTilt) > 10) SoundFX.creak();

    // ── Stability ─────────────────────────────────────────────────────────────
    // stabFloor = guaranteed minimum per pull — game always progresses toward danger
    const tiltPenalty  = Math.pow(Math.abs(newTilt)/cfg.tiltLimit, 1.6) * 45 * cfg.stabMul;
    const strucPenalty = instability * 18 * cfg.stabMul;
    const rowPenalty   = rowHeight * 8 * cfg.stabMul;
    const floorDrain   = cfg.stabFloor;
    const totalDrain   = Math.max(floorDrain, tiltPenalty + strucPenalty + rowPenalty);
    const newStab      = Math.max(0, stability - totalDrain);
    setStability(newStab);
    if (newStab < 30) SoundFX.danger();

    // Shake punch on every pull — stronger for edge/high blocks
    const shakeStrength = 4 + instability * 14 + rowHeight * 6;
    const dir = pulledDir;
    Animated.sequence([
      Animated.timing(shakeAnim,{toValue:dir*shakeStrength,duration:55,useNativeDriver:true}),
      Animated.timing(shakeAnim,{toValue:dir*-shakeStrength*0.5,duration:55,useNativeDriver:true}),
      Animated.spring(shakeAnim,{toValue:0,tension:180,friction:6,useNativeDriver:true}),
    ]).start();

    // Update wobble intensity based on new stability
    startWobble(newStab);

    // ── Score ─────────────────────────────────────────────────────────────────
    const isEdge   = block.col !== 1;
    const isHighRow= rowHeight > 0.6;
    const pts      = (isEdge?180:90) + Math.floor(rowHeight*120) + (combo>1?combo*30:0);
    const newScore = score + pts; setScore(newScore);
    setCombo(c=>c+1);
    if (comboRef.current) clearTimeout(comboRef.current);
    comboRef.current = setTimeout(()=>setCombo(1), 8000);
    setScorePopups(prev=>[...prev,{id:Date.now(),score:pts,color:isEdge?'#FF6B35':isHighRow?'#FFD700':'#90EE90'}]);

    // ── Collapse check ────────────────────────────────────────────────────────
    // Hard thresholds first — these ALWAYS collapse, no randomness
    if (newStab <= 0 || Math.abs(newTilt) >= cfg.tiltLimit) {
      triggerCollapse(newTilt); return;
    }

    // Soft random collapse — probability rises steeply as things get bad
    const tiltRatio  = Math.abs(newTilt) / cfg.tiltLimit;   // 0..1
    const stabRatio  = 1 - newStab / 100;                    // 0..1 (1 = no stability)
    const tiltRisk   = Math.pow(tiltRatio,  1.8) * 0.55 * cfg.collapseMul;
    const stabRisk   = Math.pow(stabRatio,  1.4) * 0.60 * cfg.collapseMul;
    const structRisk = Math.pow(instability,1.6) * 0.30 * cfg.collapseMul;
    const cp         = Math.min(0.95, tiltRisk + stabRisk + structRisk);

    if (Math.random() < cp) { triggerCollapse(newTilt); return; }
    if(newCount>=cfg.target){
      cleanup(); SoundFX.win(); gameOverRef.current=true;
      const next=levelIdx+1;
      if(next<LEVELS.length) setUnlockedLevels(prev=>prev.includes(next)?prev:[...prev,next]);
      setHighScores(prev=>({...prev,[levelIdx]:Math.max(prev[levelIdx]||0,newScore)}));
      setWon(true); setTimeout(()=>setScreen('result'),600);
    }
  },[tower,levelIdx,removedCount,score,combo,triggerCollapse]);

  const isNewHigh=score>(highScores[levelIdx]||0);
  return(
    <>
      <StatusBar style="light"/>
      {screen==='menu'&&<MenuScreen onStart={startLevel} unlockedLevels={unlockedLevels} highScores={highScores}/>}
      {screen==='game'&&<GameScreen levelIdx={levelIdx} tower={tower} selected={selected} setSelected={setSelected}
        tiltAnim={tiltAnim} shakeAnim={shakeAnim} wobbleAnim={wobbleAnim} scaleAnim={scaleAnim}
        removedCount={removedCount} stability={stability}
        score={score} combo={combo} timeLeft={timeLeft} distraction={distraction} scorePopups={scorePopups}
        onPullBlock={handlePullBlock} onMenu={()=>{cleanup();gameOverRef.current=true;setScreen('menu');}}
        onPopupDone={(id)=>setScorePopups(prev=>prev.filter(p=>p.id!==id))}/>}
      {screen==='result'&&<ResultScreen won={won} levelIdx={levelIdx} removedCount={removedCount}
        score={score} highScore={highScores[levelIdx]||0} isNewHigh={isNewHigh}
        onReplay={()=>startLevel(levelIdx)} onNext={()=>startLevel(levelIdx+1)} onMenu={()=>setScreen('menu')}/>}
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S=StyleSheet.create({
  root:{flex:1},safe:{flex:1},
  menuScroll:{alignItems:'center',paddingHorizontal:20,paddingTop:28,paddingBottom:28},
  heroBox:{alignItems:'center',marginBottom:26,width:'100%'},
  logoRing:{width:66,height:66,borderRadius:33,backgroundColor:'rgba(180,100,30,0.10)',borderWidth:1,borderColor:'rgba(200,130,50,0.28)',alignItems:'center',justifyContent:'center',marginBottom:12},
  logo:{fontSize:50,fontWeight:'900',color:'#D9914A',letterSpacing:16,marginBottom:10,textShadowColor:'rgba(200,100,20,0.4)',textShadowOffset:{width:0,height:3},textShadowRadius:10},
  divRow:{flexDirection:'row',alignItems:'center',gap:10,width:150,marginBottom:10},
  divLine:{flex:1,height:1,backgroundColor:'#3A1E0A'},
  divDot:{color:'#6A3818',fontSize:7},
  logoSub:{fontSize:9,color:'#542E14',letterSpacing:4,fontWeight:'700'},
  howBox:{width:'100%',borderRadius:16,backgroundColor:'rgba(14,7,2,0.88)',borderWidth:1,borderColor:'rgba(70,38,10,0.28)',padding:16,marginBottom:22},
  howHeader:{flexDirection:'row',alignItems:'center',gap:10,marginBottom:14},
  howLine:{flex:1,height:1,backgroundColor:'rgba(70,38,10,0.4)'},
  howTitle:{color:'#6A4020',fontSize:9,fontWeight:'900',letterSpacing:3},
  howRow:{flexDirection:'row',alignItems:'flex-start',gap:12,marginBottom:9},
  howIcon:{fontSize:14,width:22,textAlign:'center',marginTop:1},
  howText:{color:'#6A4A30',fontSize:12,lineHeight:19,flex:1},
  secRow:{flexDirection:'row',alignItems:'center',gap:10,width:'100%',marginBottom:14,marginTop:4},
  secLine:{flex:1,height:1,backgroundColor:'#281208'},
  secLabel:{color:'#4A2E14',fontSize:9,fontWeight:'900',letterSpacing:3},
  lvlCard:{width:'100%',borderRadius:16,backgroundColor:'rgba(14,7,2,0.98)',borderWidth:1,borderColor:'rgba(60,32,8,0.55)',marginBottom:12,overflow:'hidden',flexDirection:'row',alignItems:'stretch',elevation:8},
  lvlCardLocked:{opacity:0.28},
  lvlStripe:{width:5},
  lvlEmoji:{fontSize:24,paddingHorizontal:14,alignSelf:'center'},
  diffBadge:{borderRadius:5,paddingHorizontal:7,paddingVertical:2,borderWidth:1},
  diffBadgeTxt:{fontSize:9,fontWeight:'900',letterSpacing:1.5},
  timeBadge:{backgroundColor:'rgba(80,130,200,0.10)',borderRadius:5,paddingHorizontal:7,paddingVertical:2,borderWidth:1,borderColor:'rgba(80,130,200,0.28)'},
  timeBadgeTxt:{color:'#7AA8CC',fontSize:9,fontWeight:'800',letterSpacing:0.5},
  chaosBadge:{backgroundColor:'rgba(220,60,60,0.10)',borderRadius:5,paddingHorizontal:7,paddingVertical:2,borderWidth:1,borderColor:'rgba(220,60,60,0.28)'},
  chaosBadgeTxt:{color:'#CC5050',fontSize:9,fontWeight:'800',letterSpacing:0.5},
  lvlName:{fontSize:17,fontWeight:'800',letterSpacing:0.3,marginBottom:1},
  lvlMeta:{fontSize:11,fontWeight:'500'},
  hsVal:{color:'#C49030',fontSize:11,fontWeight:'800',letterSpacing:0.5},
  lvlArrow:{fontSize:28,fontWeight:'300',paddingHorizontal:14,alignSelf:'center'},
  creditsBox:{width:'100%',alignItems:'center',paddingVertical:22,marginTop:8},
  creditsTitle:{color:'#3A1E08',fontSize:8,fontWeight:'900',letterSpacing:4,marginBottom:12,marginTop:12},
  creditsLine:{marginBottom:4},
  creditsLbl:{color:'#4A2A10',fontSize:12},
  creditsName:{color:'#9A6030',fontSize:12,fontWeight:'800'},
  hud:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:16,paddingVertical:10,borderBottomWidth:1,borderBottomColor:'rgba(50,25,5,0.6)',backgroundColor:'rgba(4,2,0,0.5)'},
  hudBack:{flexDirection:'row',alignItems:'center',gap:2,padding:4},
  hudBackArrow:{color:'#4A2A14',fontSize:24,lineHeight:26,marginTop:-2},
  hudBackTxt:{color:'#4A2A14',fontSize:10,fontWeight:'900',letterSpacing:2},
  hudLevel:{color:'#B87030',fontSize:11,fontWeight:'900',letterSpacing:2.5},
  hudScoreBox:{backgroundColor:'rgba(12,6,1,0.95)',borderRadius:12,paddingHorizontal:12,paddingVertical:5,borderWidth:1,borderColor:'rgba(70,38,8,0.5)',alignItems:'center',minWidth:58},
  hudScoreNum:{color:'#FFD040',fontSize:19,fontWeight:'900',letterSpacing:0.5},
  hudScoreLbl:{color:'#3A2010',fontSize:7,fontWeight:'900',letterSpacing:2.5},
  statsRow:{flexDirection:'row',alignItems:'center',paddingHorizontal:14,paddingVertical:7,gap:10,borderBottomWidth:1,borderBottomColor:'rgba(35,18,4,0.5)'},
  comboBadge:{backgroundColor:'rgba(255,100,40,0.12)',borderRadius:20,paddingHorizontal:10,paddingVertical:4,borderWidth:1,borderColor:'rgba(255,100,40,0.32)',minWidth:58,alignItems:'center'},
  comboTxt:{color:'#FF6A30',fontSize:11,fontWeight:'900'},
  comboBlank:{borderRadius:20,paddingHorizontal:10,paddingVertical:4,borderWidth:1,borderColor:'rgba(50,25,5,0.18)',minWidth:58,alignItems:'center'},
  comboBlankTxt:{color:'#2A1408',fontSize:11,fontWeight:'700'},
  progWrap:{flex:1,alignItems:'center',gap:3},
  progTrack:{width:'100%',height:5,backgroundColor:'rgba(20,10,2,0.95)',borderRadius:3,overflow:'hidden',borderWidth:1,borderColor:'rgba(55,28,6,0.4)'},
  progFill:{height:'100%',borderRadius:3,backgroundColor:'#C07030'},
  progLbl:{color:'#5A3018',fontSize:9,fontWeight:'800',letterSpacing:1},
  timerPill:{backgroundColor:'rgba(14,7,1,0.95)',borderRadius:12,paddingHorizontal:10,paddingVertical:5,borderWidth:1,borderColor:'rgba(55,28,6,0.4)',minWidth:58,alignItems:'center'},
  timerDanger:{backgroundColor:'rgba(60,4,4,0.95)',borderColor:'rgba(200,50,50,0.55)'},
  timerTxt:{color:'#B47030',fontSize:12,fontWeight:'900',letterSpacing:0.5},
  timerBlank:{borderRadius:12,paddingHorizontal:10,paddingVertical:5,borderWidth:1,borderColor:'rgba(40,20,4,0.18)',minWidth:58,alignItems:'center'},
  timerBlankTxt:{color:'#281408',fontSize:14,fontWeight:'300'},
  hintTxt:{color:'#5A3618',fontSize:11,backgroundColor:'rgba(8,4,0,0.85)',paddingHorizontal:16,paddingVertical:5,borderRadius:22,overflow:'hidden',borderWidth:1,borderColor:'rgba(50,25,5,0.28)',letterSpacing:0.3},
  towerArea:{flexGrow:1,alignItems:'center',justifyContent:'flex-end',paddingVertical:8},
  scorePopup:{fontSize:28,fontWeight:'900',textShadowColor:'rgba(0,0,0,0.95)',textShadowOffset:{width:0,height:2},textShadowRadius:8},
  distrBanner:{backgroundColor:'rgba(6,3,0,0.99)',borderRadius:18,padding:22,borderWidth:2,borderColor:'#FF5722',alignItems:'center',minWidth:260,maxWidth:310,elevation:20},
  distrTitle:{color:'#FF5722',fontSize:20,fontWeight:'900',marginBottom:5},
  distrDesc:{color:'#A86030',fontSize:13,textAlign:'center',lineHeight:18},
  stabWrap:{paddingHorizontal:16,paddingBottom:18,paddingTop:10,borderTopWidth:1,borderTopColor:'rgba(40,20,4,0.5)'},
  stabLbl:{color:'#3A1E08',fontSize:9,fontWeight:'900',letterSpacing:2.5},
  stabPct:{fontSize:10,fontWeight:'900',letterSpacing:1},
  stabTrack:{height:8,backgroundColor:'rgba(14,7,1,0.95)',borderRadius:4,overflow:'visible',borderWidth:1,borderColor:'rgba(50,25,5,0.4)',position:'relative'},
  stabFill:{height:'100%',borderRadius:4,position:'absolute',left:0,top:0,bottom:0},
  stabTick:{position:'absolute',top:0,bottom:0,width:1,backgroundColor:'rgba(0,0,0,0.4)'},
  dangerTxt:{color:'#FF4444',fontSize:11,fontWeight:'900',textAlign:'center',marginTop:7,letterSpacing:1.5},
  resWrap:{flex:1,alignItems:'center',justifyContent:'center',padding:26},
  resIconRing:{width:110,height:110,borderRadius:55,borderWidth:2,alignItems:'center',justifyContent:'center',backgroundColor:'rgba(255,255,255,0.03)'},
  resIcon:{fontSize:56},
  resTitle:{fontSize:28,fontWeight:'900',letterSpacing:2.5,marginBottom:5},
  resSub:{fontSize:13,fontWeight:'600',letterSpacing:1,marginBottom:24,opacity:0.8},
  scoreCard:{width:'100%',backgroundColor:'rgba(255,255,255,0.04)',borderRadius:18,padding:18,marginBottom:26,borderWidth:1},
  scoreRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingVertical:7},
  scoreDiv:{height:1,backgroundColor:'rgba(255,255,255,0.06)',marginVertical:2},
  sk:{color:'#444',fontSize:13},
  sv:{color:'#C0C0C0',fontSize:16,fontWeight:'800'},
  resBtn:{width:'100%',paddingVertical:17,borderRadius:15,alignItems:'center',marginBottom:10,elevation:4,borderWidth:1},
  rbt:{color:'#DDB070',fontSize:14,fontWeight:'900',letterSpacing:3},
});
