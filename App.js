import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, SafeAreaView, Animated, PanResponder,
  Dimensions, Vibration,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { G, Rect, Polygon, Line, Defs,
  LinearGradient as SvgGrad, Stop } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';

const { width: SW, height: SH } = Dimensions.get('window');

// ── Dimensions ────────────────────────────────────────────────────────────────
const COLS = 3;
const TOWER_W = Math.floor(SW * 0.82);
const BW = Math.floor((TOWER_W - 6) / 3);
const BH = Math.floor(BW * 0.36);
const GAP = 2;
const ROW_H = BH + GAP;

// Isometric projection offsets
const ISO_X = BW * 0.18;
const ISO_Y = BH * 0.55;

// Wood palette
const WOOD = [
  { top:'#E8A85C', side:'#A06828', front:'#C8883C' },
  { top:'#DCA050', side:'#986020', front:'#BC7830' },
  { top:'#E4A458', side:'#9C6824', front:'#C48035' },
  { top:'#D89848', side:'#906018', front:'#B8742C' },
  { top:'#EAA85E', side:'#A46A28', front:'#CC8840' },
  { top:'#D49645', side:'#8C5C18', front:'#B47030' },
];

const LEVELS = [
  { id:1, rows:9,  label:'Beginner',    emoji:'🪵', target:5,  timeLimit:0,   distrChance:0,   tiltScale:0.25, collapseScale:0.15 },
  { id:2, rows:12, label:'Casual',      emoji:'🏗️', target:8,  timeLimit:0,   distrChance:0,   tiltScale:0.45, collapseScale:0.35 },
  { id:3, rows:15, label:'Challenging', emoji:'😤', target:11, timeLimit:120, distrChance:0.3, tiltScale:0.65, collapseScale:0.60 },
  { id:4, rows:18, label:'Expert',      emoji:'🔥', target:14, timeLimit:90,  distrChance:0.5, tiltScale:0.82, collapseScale:0.80 },
  { id:5, rows:21, label:'Master',      emoji:'💀', target:17, timeLimit:60,  distrChance:0.7, tiltScale:1.00, collapseScale:1.00 },
];

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
  const topRow = getTopRow(tower);
  // Top 2 rows can never be removed (you can only place on top in real Jenga)
  if (block.row >= topRow - 1) return false;
  // Must have at least one other block in the row remaining
  const rowBlocks = tower[block.row].filter(b => !b.removed);
  if (rowBlocks.length < 2) return false;
  // Structural check: the row directly above needs at least one block
  // that has support. If removing this block leaves the row above
  // entirely unsupported on one side, prevent removal.
  const rowAbove = tower[block.row + 1];
  if (rowAbove) {
    const aboveBlocks = rowAbove.filter(b => !b.removed);
    const remainingInRow = rowBlocks.filter(b => b.id !== block.id);
    // If only 1 block would remain and it's the center, row above is fine
    // If only 1 block would remain and it's an edge, check row above isn't all on opposite side
    if (remainingInRow.length === 1 && aboveBlocks.length === 3) {
      // Would leave only 1 support — too unstable to allow
      // (mirrors real Jenga: you can't take a block that leaves above totally one-sided)
      // Allow it but it becomes a high-instability pull handled by physics
    }
  }
  return true;
}

// Structural integrity — how much this pull destabilizes the tower
function getInstabilityScore(block, tower) {
  const rowBlocks  = tower[block.row].filter(b => !b.removed);
  const remaining  = rowBlocks.filter(b => b.id !== block.id);
  const rowHeight  = block.row / tower.length;

  // Worst case: last block in a row (only 1 left after this)
  if (remaining.length === 1) {
    // Middle col is worst — leaves an edge block only, tower leans hard
    return block.col === 1 ? 0.80 : 0.55;
  }
  // Safe center block, 2 others remain — very stable
  if (block.col === 1 && remaining.length === 2) return 0.05;
  // Edge block, 2 others remain — slightly risky, more so higher up
  return 0.20 + rowHeight * 0.15;
}

// ── Isometric Block Renderer ──────────────────────────────────────────────────
function IsoBlock({ x, y, w, h, wood, isSelected, isRemovable, dimmed }) {
  const { top: ct, side: cs, front: cf } = WOOD[wood];
  const ix = ISO_X, iy = ISO_Y;

  // Isometric faces
  const topPts    = `${x},${y} ${x+w},${y} ${x+w+ix},${y-iy} ${x+ix},${y-iy}`;
  const frontPts  = `${x},${y} ${x+w},${y} ${x+w},${y+h} ${x},${y+h}`;
  const sidePts   = `${x+w},${y} ${x+w+ix},${y-iy} ${x+w+ix},${y-iy+h} ${x+w},${y+h}`;

  const selColor = '#FFD700';
  const opacity = dimmed ? 0.45 : 1;

  return (
    <G opacity={opacity}>
      {/* Shadow */}
      <Polygon
        points={`${x+3},${y+h+2} ${x+w+3},${y+h+2} ${x+w+ix+3},${y-iy+h+2} ${x+ix+3},${y-iy+h+2}`}
        fill="rgba(0,0,0,0.2)"
      />
      {/* Front face */}
      <Polygon points={frontPts} fill={cf}
        stroke={isSelected ? selColor : 'rgba(0,0,0,0.4)'} strokeWidth={isSelected ? 2 : 0.8} />
      {/* Side face */}
      <Polygon points={sidePts} fill={cs}
        stroke={isSelected ? selColor : 'rgba(0,0,0,0.5)'} strokeWidth={isSelected ? 2 : 0.8} />
      {/* Top face */}
      <Polygon points={topPts} fill={ct}
        stroke={isSelected ? selColor : 'rgba(0,0,0,0.25)'} strokeWidth={isSelected ? 2 : 0.6} />

      {/* Wood grain on top */}
      {[0.25, 0.5, 0.75].map((t, i) => (
        <Line key={i}
          x1={x + w*t} y1={y} x2={x + w*t + ix} y2={y - iy}
          stroke="rgba(0,0,0,0.08)" strokeWidth={0.7} />
      ))}

      {/* Highlight on top */}
      <Polygon
        points={`${x+2},${y-2} ${x+w*0.6},${y-2} ${x+w*0.6+ix*0.6},${y-iy*0.6-2} ${x+ix*0.6},${y-iy*0.6-2}`}
        fill="rgba(255,255,255,0.18)"
      />

      {/* Selected glow */}
      {isSelected && (
        <Polygon points={topPts} fill="rgba(255,215,0,0.2)" />
      )}

      {/* Removability hint */}
      {isRemovable && !isSelected && (
        <Polygon points={topPts} fill="rgba(255,255,255,0.08)" />
      )}
    </G>
  );
}

// ── Tower with drag-to-pull ───────────────────────────────────────────────────
function TowerView({ tower, selected, setSelected, onPullBlock, tiltAnim, shakeAnim, levelIdx }) {
  const rows = tower.length;
  // Extra height for iso projection
  const svgH = rows * ROW_H + ISO_Y + 60;
  const svgW = SW - 20;

  // Center tower in SVG
  const towerTotalW = COLS * BW + (COLS - 1) * GAP;
  const startX = (svgW - towerTotalW - ISO_X) / 2;

  // Drag state per block
  const dragRef = useRef({ blockId: null, startX: 0, dx: 0, pulling: false });
  const dragAnims = useRef({});

  // Create pan responder for each block touch
  const createPanResponder = useCallback((block) => {
    if (!canRemove(block, tower)) return { panHandlers: {} };

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 4,

      onPanResponderGrant: () => {
        SoundFX.select();
        setSelected(block);
        dragRef.current = { blockId: block.id, startX: 0, dx: 0, pulling: false };
        if (!dragAnims.current[block.id]) {
          dragAnims.current[block.id] = new Animated.Value(0);
        }
      },

      onPanResponderMove: (_, g) => {
        dragRef.current.dx = g.dx;
        const anim = dragAnims.current[block.id];
        if (anim) anim.setValue(g.dx);
        // Creak when dragged significantly
        if (Math.abs(g.dx) > 20 && !dragRef.current.pulling) {
          dragRef.current.pulling = true;
          SoundFX.creak();
        }
      },

      onPanResponderRelease: (_, g) => {
        const { dx } = g;
        const anim = dragAnims.current[block.id];
        const threshold = BW * 0.65; // must drag 65% of block width

        if (Math.abs(dx) >= threshold) {
          // Successful pull
          Animated.timing(anim, {
            toValue: dx > 0 ? SW : -SW,
            duration: 180,
            useNativeDriver: true,
          }).start(() => {
            if (anim) anim.setValue(0);
            delete dragAnims.current[block.id];
            onPullBlock(block, dx);
          });
        } else {
          // Not enough — snap back
          Animated.spring(anim, {
            toValue: 0,
            tension: 120,
            friction: 8,
            useNativeDriver: true,
          }).start();
          SoundFX.creak();
          setSelected(null);
        }
        dragRef.current.pulling = false;
      },

      onPanResponderTerminate: () => {
        const anim = dragAnims.current[block.id];
        if (anim) {
          Animated.spring(anim, { toValue: 0, tension: 120, friction: 8, useNativeDriver: true }).start();
        }
        setSelected(null);
      },
    });
  }, [tower, setSelected, onPullBlock]);

  // Sort blocks bottom to top for correct iso rendering
  const visibleBlocks = tower.flat()
    .filter(b => !b.removed)
    .sort((a, b) => a.row - b.row || a.col - b.col);

  return (
    <Animated.View style={{
      width: svgW,
      height: svgH,
      transform: [
        { rotate: tiltAnim.interpolate({ inputRange:[-90,90], outputRange:['-90deg','90deg'] }) },
        { translateX: shakeAnim },
      ],
      alignSelf: 'center',
    }}>
      <Svg width={svgW} height={svgH} style={StyleSheet.absoluteFill} pointerEvents="none">
        {visibleBlocks.map(block => {
          const { row, col, wood, ox, oy } = block;
          const isSelected = selected?.id === block.id;
          const removable = canRemove(block, tower);
          // Alternate row direction for isometric feel
          const actualCol = row % 2 === 0 ? col : col;
          const bx = startX + actualCol * (BW + GAP) + ox;
          const by = svgH - 30 - (row * ROW_H) - BH + oy;

          return (
            <IsoBlock
              key={block.id}
              x={bx} y={by} w={BW} h={BH}
              wood={wood}
              isSelected={isSelected}
              isRemovable={removable}
              dimmed={selected && selected.id !== block.id && !removable}
            />
          );
        })}
      </Svg>

      {/* Drag touch layer */}
      {visibleBlocks.map(block => {
        const { row, col, ox, oy } = block;
        const removable = canRemove(block, tower);
        const bx = startX + col * (BW + GAP) + ox;
        const by = svgH - 30 - (row * ROW_H) - BH + oy;
        const panResponder = removable ? createPanResponder(block) : null;
        const dragAnim = dragAnims.current[block.id] || new Animated.Value(0);

        return (
          <Animated.View
            key={`touch-${block.id}`}
            {...(panResponder ? panResponder.panHandlers : {})}
            style={{
              position: 'absolute',
              left: bx,
              top: by - ISO_Y,
              width: BW + ISO_X,
              height: BH + ISO_Y,
              transform: [{ translateX: dragAnim }],
            }}
          />
        );
      })}
    </Animated.View>
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
  return (
    <LinearGradient colors={['#1A0A04','#2C1508','#3D2010']} style={S.root}>
      <SafeAreaView style={S.safe}>
        <ScrollView contentContainerStyle={S.menuScroll}>
          <View style={S.logoBox}>
            <Text style={S.logo}>JENGA</Text>
            <View style={S.logoLine} />
            <Text style={S.logoSub}>DRAG TO PULL · DON'T LET IT FALL</Text>
          </View>

          {/* Instructions */}
          <View style={S.instructions}>
            <Text style={S.instrTitle}>HOW TO PLAY</Text>
            <Text style={S.instrLine}>← Swipe block left or right to pull it out</Text>
            <Text style={S.instrLine}>⚡ Short swipe = snaps back, must go past 65%</Text>
            <Text style={S.instrLine}>🏗️ Center blocks = safe · Edge blocks = risky</Text>
            <Text style={S.instrLine}>🧱 Last 2 in a row — pulling middle = collapse!</Text>
          </View>

          {LEVELS.map((lvl, i) => {
            const locked = !unlockedLevels.includes(i);
            const hs = highScores[i] || 0;
            return (
              <TouchableOpacity key={lvl.id}
                style={[S.lvlBtn, locked && { opacity: 0.3 }]}
                disabled={locked} onPress={() => onStart(i)} activeOpacity={0.75}
              >
                <View style={[S.lvlAccent, { backgroundColor: WOOD[i % WOOD.length].front }]} />
                <Text style={S.lvlEmoji}>{lvl.emoji}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={S.lvlNum}>LEVEL {lvl.id}  {lvl.timeLimit > 0 ? `⏱${lvl.timeLimit}s` : 'NO TIMER'}</Text>
                  <Text style={S.lvlName}>{lvl.label}</Text>
                  {lvl.distrChance > 0 && <Text style={S.lvlDistr}>💥 Distractions active</Text>}
                </View>
                <View style={{ alignItems: 'flex-end', marginRight: 12 }}>
                  {locked ? <Text style={{ fontSize: 20 }}>🔒</Text> : (
                    <>
                      <Text style={S.lvlRows}>{lvl.rows} rows</Text>
                      {hs > 0 && <Text style={S.highScore}>🏆 {hs}</Text>}
                    </>
                  )}
                </View>
              </TouchableOpacity>
            );
          })}
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
  const stabColor = stability > 60 ? '#5DBB63' : stability > 30 ? '#F5C518' : '#E84040';
  const isTimedLevel = lvl.timeLimit > 0;
  const timeWarning = isTimedLevel && timeLeft <= 15;

  return (
    <LinearGradient colors={['#0A0401','#160802','#221005']} style={S.root}>
      <SafeAreaView style={S.safe}>
        {/* Header */}
        <View style={S.hdr}>
          <TouchableOpacity onPress={onMenu} style={S.back}>
            <Text style={S.backTxt}>← MENU</Text>
          </TouchableOpacity>
          <View style={{ alignItems: 'center' }}>
            <Text style={S.hdrSub}>{lvl.emoji} LEVEL {lvl.id}</Text>
            <Text style={S.hdrName}>{lvl.label.toUpperCase()}</Text>
          </View>
          <View style={S.scoreWrap}>
            <Text style={S.scoreN}>{score}</Text>
            <Text style={S.scoreL}>pts</Text>
          </View>
        </View>

        {/* Sub-header */}
        <View style={S.subHdr}>
          {combo > 1 && (
            <View style={S.comboBadge}>
              <Text style={S.comboTxt}>🔥 ×{combo} COMBO</Text>
            </View>
          )}
          <View style={{ flex: 1 }} />
          {isTimedLevel && (
            <View style={[S.timerBox, timeWarning && S.timerWarn]}>
              <Text style={[S.timerTxt, timeWarning && { color: '#FF3030' }]}>⏱ {timeLeft}s</Text>
            </View>
          )}
          <View style={S.pullsBox}>
            <Text style={S.pullsTxt}>{removedCount} / {lvl.target}</Text>
          </View>
        </View>

        {/* Hint */}
        <View style={S.hintWrap}>
          <Text style={S.hintTxt}>
            {selected ? '← Swipe left or right to pull →' : '👆 Touch & drag a block sideways'}
          </Text>
        </View>

        {/* Tower */}
        <View style={{ flex: 1, overflow: 'hidden' }}>
          <ScrollView contentContainerStyle={S.towerArea} showsVerticalScrollIndicator={false}>
            <TowerView
              tower={tower}
              selected={selected}
              setSelected={setSelected}
              onPullBlock={onPullBlock}
              tiltAnim={tiltAnim}
              shakeAnim={shakeAnim}
              levelIdx={levelIdx}
            />
          </ScrollView>

          {/* Score popups */}
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {scorePopups.map(p => (
              <View key={p.id} style={[StyleSheet.absoluteFill, { justifyContent: 'center', alignItems: 'center' }]}>
                <ScorePopup score={p.score} color={p.color} onDone={() => onPopupDone(p.id)} />
              </View>
            ))}
          </View>

          {/* Distraction */}
          <View style={[StyleSheet.absoluteFill, { justifyContent: 'center', alignItems: 'center' }]} pointerEvents="none">
            <DistractionBanner distraction={distraction} />
          </View>
        </View>

        {/* Stability */}
        <View style={S.stabWrap}>
          <View style={S.stabTop}>
            <Text style={S.stabLbl}>STRUCTURAL INTEGRITY</Text>
            <Text style={[S.stabPct, { color: stabColor }]}>{Math.round(stability)}%</Text>
          </View>
          <View style={S.stabBar}>
            <Animated.View style={[S.stabFill, { width: `${stability}%`, backgroundColor: stabColor }]} />
          </View>
          {stability < 30 && <Text style={S.danger}>⚠️  CRITICAL — ONE WRONG MOVE</Text>}
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}

// ── Result ────────────────────────────────────────────────────────────────────
function ResultScreen({ won, levelIdx, removedCount, score, highScore, isNewHigh, onReplay, onNext, onMenu }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(anim, { toValue: 1, tension: 55, friction: 6, useNativeDriver: true }).start();
  }, []);
  return (
    <LinearGradient colors={won ? ['#041A0D','#0A3018','#105022'] : ['#1A0404','#300A0A','#501010']} style={S.root}>
      <SafeAreaView style={S.safe}>
        <Animated.View style={[S.resWrap, { transform:[{scale:anim}], opacity:anim }]}>
          <Text style={S.resIcon}>{won ? '🏆' : '💥'}</Text>
          <Text style={[S.resTitle, { color: won ? '#5DBB63' : '#E84040' }]}>
            {won ? 'TOWER SURVIVED!' : 'TOWER FELL!'}
          </Text>
          <View style={S.scoreCard}>
            <View style={S.scoreRow}><Text style={S.sk}>Blocks Removed</Text><Text style={S.sv}>{removedCount}</Text></View>
            <View style={S.scoreRow}><Text style={S.sk}>Score</Text><Text style={[S.sv,{color:'#FFD700'}]}>{score}</Text></View>
            {isNewHigh
              ? <View style={[S.scoreRow,{backgroundColor:'rgba(255,215,0,0.1)',borderRadius:8,padding:6}]}>
                  <Text style={[S.sk,{color:'#FFD700'}]}>🌟 NEW BEST!</Text>
                  <Text style={[S.sv,{color:'#FFD700'}]}>{score}</Text>
                </View>
              : highScore > 0 && <View style={S.scoreRow}><Text style={S.sk}>Best</Text><Text style={S.sv}>{highScore}</Text></View>
            }
          </View>
          <TouchableOpacity style={[S.resBtn,{backgroundColor:'#5C3317'}]} onPress={onReplay} activeOpacity={0.8}>
            <Text style={S.rbt}>🔄  PLAY AGAIN</Text>
          </TouchableOpacity>
          {won && levelIdx + 1 < LEVELS.length && (
            <TouchableOpacity style={[S.resBtn,{backgroundColor:'#1A5C2A'}]} onPress={onNext} activeOpacity={0.8}>
              <Text style={S.rbt}>➡️  NEXT LEVEL</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[S.resBtn,{backgroundColor:'#111'}]} onPress={onMenu} activeOpacity={0.8}>
            <Text style={S.rbt}>🏠  MAIN MENU</Text>
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
    Vibration.vibrate([0, 60, 30, 100, 40, 180, 60, 250]);

    // Stage 1: rapid violent shake
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue:  20, duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -24, duration: 55, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue:  18, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -20, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue:  10, duration: 45, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue:   0, duration: 60, useNativeDriver: true }),
    ]).start();

    // Stage 2: tip over after brief shake
    Animated.sequence([
      Animated.delay(200),
      Animated.timing(tiltAnim, {
        toValue: currentTilt > 0 ? 90 : -90,
        duration: 650,
        useNativeDriver: true,
      }),
    ]).start();

    setWon(false);
    setTimeout(() => setScreen('result'), 1050);
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

    const instability = getInstabilityScore(block, tower);
    const rowHeight   = block.row / cfg.rows;
    const pulledDir   = dragDx > 0 ? 1 : -1;

    // ── Tilt ──────────────────────────────────────────────────────────────────
    // Tower partially damps between pulls (springs back 10%)
    const damped    = tiltVal.current * 0.90;
    const tiltDelta = (instability * 7 + rowHeight * 3 + 0.5) * cfg.tiltScale;
    const noise     = (Math.random() - 0.5) * 1.5 * cfg.tiltScale;
    const newTilt   = Math.max(-22, Math.min(22, damped + pulledDir * tiltDelta + noise));
    tiltVal.current = newTilt;

    Animated.spring(tiltAnim, { toValue: newTilt, tension: 35, friction: 6, useNativeDriver: true }).start();
    if (Math.abs(newTilt) > 8) SoundFX.creak();

    // ── Shake on every pull — proportional to instability ────────────────────
    const shakeStr = (instability * 12 + rowHeight * 6 + 3) * cfg.tiltScale;
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue:  pulledDir * shakeStr,        duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -pulledDir * shakeStr * 0.45, duration: 50, useNativeDriver: true }),
      Animated.spring(shakeAnim, { toValue: 0, tension: 200, friction: 8, useNativeDriver: true }),
    ]).start();

    // ── Stability — CUMULATIVE from current value ─────────────────────────────
    // Drain based on tilt + instability + how many pulls done
    // Uses current `stability` state so damage accumulates properly
    const tiltDrain   = Math.pow(Math.abs(newTilt) / 22, 1.5) * 30;
    const structDrain = instability * 18;
    const pullDrain   = (newCount / cfg.target) * 12; // pressure increases as you near the target
    const totalDrain  = Math.max(3, tiltDrain + structDrain + pullDrain); // minimum 3 per pull
    const newStab     = Math.max(0, stability - totalDrain);
    setStability(newStab);
    if (newStab < 30) SoundFX.danger();

    // ── Score ─────────────────────────────────────────────────────────────────
    const isEdge   = block.col !== 1;
    const isHighRow= rowHeight > 0.6;
    const pts      = (isEdge ? 180 : 90) + Math.floor(rowHeight * 120) + (combo > 1 ? combo * 30 : 0);
    const newScore = score + pts;
    setScore(newScore);
    setCombo(c => c + 1);
    if (comboRef.current) clearTimeout(comboRef.current);
    comboRef.current = setTimeout(() => setCombo(1), 8000);
    setScorePopups(prev => [...prev, {
      id: Date.now(), score: pts,
      color: isEdge ? '#FF6B35' : isHighRow ? '#FFD700' : '#90EE90',
    }]);

    // ── Collapse check ────────────────────────────────────────────────────────
    // Hard collapses — no random
    if (newStab <= 0 || Math.abs(newTilt) >= 22) {
      triggerCollapse(newTilt); return;
    }
    // Soft random collapse — rises steeply as tilt/stability worsen
    const tiltRisk   = Math.pow(Math.abs(newTilt) / 22, 2.2) * 0.50;
    const stabRisk   = Math.pow(1 - newStab / 100, 2.0) * 0.55;
    const structRisk = Math.pow(instability, 1.6) * 0.35;
    const cp         = Math.min(0.92, (tiltRisk + stabRisk + structRisk) * cfg.collapseScale);

    if (Math.random() < cp) { triggerCollapse(newTilt); return; }

    // ── Win ───────────────────────────────────────────────────────────────────
    if (newCount >= cfg.target) {
      cleanup(); SoundFX.win(); gameOverRef.current = true;
      const next = levelIdx + 1;
      if (next < LEVELS.length)
        setUnlockedLevels(prev => prev.includes(next) ? prev : [...prev, next]);
      setHighScores(prev => ({ ...prev, [levelIdx]: Math.max(prev[levelIdx] || 0, newScore) }));
      setWon(true);
      setTimeout(() => setScreen('result'), 600);
    }
  }, [tower, levelIdx, removedCount, score, combo, stability, triggerCollapse]);

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
  root:{flex:1}, safe:{flex:1},
  menuScroll:{alignItems:'center',padding:20,paddingTop:36},
  logoBox:{alignItems:'center',marginBottom:16},
  logo:{fontSize:52,fontWeight:'900',color:'#D4924F',letterSpacing:14},
  logoLine:{width:200,height:2,backgroundColor:'#6B3D22',marginVertical:8},
  logoSub:{fontSize:11,color:'#8B6040',letterSpacing:4},
  instructions:{width:'100%',backgroundColor:'rgba(61,32,16,0.7)',borderRadius:12,padding:14,marginBottom:20,gap:5,borderWidth:1,borderColor:'rgba(139,94,60,0.3)'},
  instrTitle:{color:'#D4924F',fontWeight:'900',fontSize:11,letterSpacing:3,marginBottom:4},
  instrLine:{color:'#9A7050',fontSize:12,lineHeight:20},
  lvlBtn:{flexDirection:'row',alignItems:'center',width:'100%',backgroundColor:'#2A1408',borderRadius:12,marginBottom:10,borderWidth:1,borderColor:'#5C3010',overflow:'hidden',elevation:5},
  lvlAccent:{width:5,alignSelf:'stretch'},
  lvlEmoji:{fontSize:24,marginHorizontal:14},
  lvlNum:{color:'#8B6040',fontSize:10,fontWeight:'800',letterSpacing:2},
  lvlName:{color:'#D4924F',fontSize:16,fontWeight:'700',marginTop:2},
  lvlDistr:{color:'#FF6B35',fontSize:10,marginTop:2},
  lvlRows:{color:'#6B4020',fontSize:12},
  highScore:{color:'#FFD700',fontSize:11,fontWeight:'700'},
  hdr:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:16,paddingVertical:10,borderBottomWidth:1,borderBottomColor:'rgba(100,60,20,0.4)'},
  back:{padding:4},
  backTxt:{color:'#7A5030',fontWeight:'800',fontSize:12,letterSpacing:1},
  hdrSub:{color:'#7A5030',fontSize:10,letterSpacing:2},
  hdrName:{color:'#D4924F',fontWeight:'800',fontSize:13},
  scoreWrap:{alignItems:'center',minWidth:50},
  scoreN:{color:'#FFD700',fontSize:22,fontWeight:'900'},
  scoreL:{color:'#7A5030',fontSize:9,letterSpacing:1},
  subHdr:{flexDirection:'row',alignItems:'center',paddingHorizontal:12,paddingVertical:5,gap:8},
  comboBadge:{backgroundColor:'rgba(255,107,53,0.2)',borderRadius:20,paddingHorizontal:10,paddingVertical:3,borderWidth:1,borderColor:'rgba(255,107,53,0.4)'},
  comboTxt:{color:'#FF6B35',fontSize:12,fontWeight:'900'},
  timerBox:{backgroundColor:'rgba(80,50,20,0.6)',borderRadius:8,paddingHorizontal:10,paddingVertical:3},
  timerWarn:{backgroundColor:'rgba(100,10,10,0.8)',borderWidth:1,borderColor:'#FF3030'},
  timerTxt:{color:'#D4924F',fontSize:13,fontWeight:'800'},
  pullsBox:{backgroundColor:'rgba(40,20,8,0.8)',borderRadius:8,paddingHorizontal:10,paddingVertical:3},
  pullsTxt:{color:'#7A5030',fontSize:12},
  hintWrap:{alignItems:'center',paddingVertical:5},
  hintTxt:{color:'#9A7050',fontSize:12,backgroundColor:'rgba(40,20,8,0.9)',paddingHorizontal:14,paddingVertical:5,borderRadius:20,overflow:'hidden'},
  towerArea:{flexGrow:1,alignItems:'center',justifyContent:'flex-end',paddingVertical:8},
  scorePopup:{fontSize:26,fontWeight:'900',textShadowColor:'rgba(0,0,0,0.9)',textShadowOffset:{width:1,height:1},textShadowRadius:6},
  distrBanner:{backgroundColor:'rgba(10,4,0,0.97)',borderRadius:16,padding:20,borderWidth:2,borderColor:'#FF6B35',alignItems:'center',minWidth:260,maxWidth:300},
  distrTitle:{color:'#FF6B35',fontSize:20,fontWeight:'900',marginBottom:4},
  distrDesc:{color:'#C8844A',fontSize:13,textAlign:'center'},
  stabWrap:{paddingHorizontal:20,paddingBottom:18,paddingTop:6},
  stabTop:{flexDirection:'row',justifyContent:'space-between',marginBottom:5},
  stabLbl:{color:'#7A5030',fontSize:10,fontWeight:'800',letterSpacing:2},
  stabPct:{fontSize:11,fontWeight:'900'},
  stabBar:{width:'100%',height:8,backgroundColor:'rgba(100,60,20,0.3)',borderRadius:99,overflow:'hidden'},
  stabFill:{height:'100%',borderRadius:99},
  danger:{color:'#E84040',fontSize:11,fontWeight:'700',textAlign:'center',marginTop:5,letterSpacing:1},
  resWrap:{flex:1,alignItems:'center',justifyContent:'center',padding:28},
  resIcon:{fontSize:72,marginBottom:16},
  resTitle:{fontSize:26,fontWeight:'900',letterSpacing:3,marginBottom:6},
  scoreCard:{width:'100%',backgroundColor:'rgba(255,255,255,0.06)',borderRadius:14,padding:16,marginBottom:24,gap:10},
  scoreRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center'},
  sk:{color:'#888',fontSize:13},
  sv:{color:'#ccc',fontSize:16,fontWeight:'800'},
  resBtn:{width:'100%',padding:17,borderRadius:12,alignItems:'center',marginBottom:10,elevation:4},
  rbt:{color:'#fff',fontSize:15,fontWeight:'800',letterSpacing:2},
});
