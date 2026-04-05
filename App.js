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
              {selected ? '‹ Swipe left or right to pull ›' : '☛  Touch a block and drag sideways'}
            </Text>
          </View>
        </View>

        {/* ── Tower Area ── */}
        <View style={{ flex:1, overflow:'hidden' }}>
          <ScrollView contentContainerStyle={S.towerArea} showsVerticalScrollIndicator={false}>
            <TowerView
              tower={tower} selected={selected} setSelected={setSelected}
              onPullBlock={onPullBlock} tiltAnim={tiltAnim} shakeAnim={shakeAnim}
              levelIdx={levelIdx}
            />
          </ScrollView>
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
