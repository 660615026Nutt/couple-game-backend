const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const rooms = {};

// สับไพ่
const shuffleArray = (array) => {
  let shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

// เติมไพ่เวลาไพ่กองกลางจะหมด
const drawFromDeck = (room) => {
  if (room.deck.length < 5) {
    const colors = ['red', 'blue', 'green', 'yellow'];
    let newDeck = [];
    colors.forEach(color => {
      for(let i=1; i<=9; i++) newDeck.push({ type: 'uno', color, value: `${i}`, name: `${i}` });
    });
    room.deck = room.deck.concat(shuffleArray(newDeck));
  }
  return room.deck.shift();
};

// --- ลอจิกเกม ดงระเบิด ---
const setupBombGame = (roomId) => {
  let baseCards = [];
  for (let i = 0; i < 6; i++) baseCards.push({ type: 'skip', name: '⏭️ ชิ่งหนี' });
  for (let i = 0; i < 6; i++) baseCards.push({ type: 'attack', name: '⚔️ โจมตี' });
  for (let i = 0; i < 4; i++) baseCards.push({ type: 'see', name: '👁️ แอบดูกอง' });
  for (let i = 0; i < 5; i++) baseCards.push({ type: 'task', name: '📜 ภารกิจ', desc: 'สั่งให้อีกฝ่ายทำ!' });
  baseCards = shuffleArray(baseCards);

  let p1Hand = baseCards.splice(0, 4);
  let p2Hand = baseCards.splice(0, 4);
  p1Hand.push({ type: 'defuse', name: '🛡️ การ์ดง้อ' });
  p2Hand.push({ type: 'defuse', name: '🛡️ การ์ดง้อ' });

  baseCards.push({ type: 'defuse', name: '🛡️ การ์ดง้อ' });
  baseCards.push({ type: 'bomb', name: '💣 ระเบิด' });
  
  rooms[roomId].deck = shuffleArray(baseCards);
  rooms[roomId].hands = { [rooms[roomId].players[0].id]: shuffleArray(p1Hand), [rooms[roomId].players[1].id]: shuffleArray(p2Hand) };
  rooms[roomId].turnIndex = Math.random() > 0.5 ? 0 : 1;
  rooms[roomId].turnsToTake = 1;
  rooms[roomId].gameOver = false;
  rooms[roomId].message = `เริ่มเกมดงระเบิด! ตาของ ${rooms[roomId].players[rooms[roomId].turnIndex].name}`;
};

// --- ลอจิกเกม UNO (Full Option) ---
const setupUnoGame = (roomId) => {
  const colors = ['red', 'blue', 'green', 'yellow'];
  let deck = [];
  
  // ไพ่มาตรฐาน: เลข 0, 1-9, Skip, Reverse, +2
  colors.forEach(color => {
    deck.push({ type: 'uno', color, value: '0', name: '0' });
    for(let i=1; i<=9; i++) {
      deck.push({ type: 'uno', color, value: `${i}`, name: `${i}` });
      deck.push({ type: 'uno', color, value: `${i}`, name: `${i}` });
    }
    deck.push({ type: 'uno', color, value: 'skip', name: '🚫' });
    deck.push({ type: 'uno', color, value: 'skip', name: '🚫' });
    deck.push({ type: 'uno', color, value: 'reverse', name: '🔁' });
    deck.push({ type: 'uno', color, value: 'reverse', name: '🔁' });
    deck.push({ type: 'uno', color, value: '+2', name: '+2' });
    deck.push({ type: 'uno', color, value: '+2', name: '+2' });
  });
  
  // ไพ่พิเศษ: เปลี่ยนสี (Wild) และ +4
  for(let i=0; i<4; i++) {
    deck.push({ type: 'uno', color: 'wild', value: 'wild', name: '🌈' });
    deck.push({ type: 'uno', color: 'wild', value: '+4', name: '+4' });
  }
  
  deck = shuffleArray(deck);
  let p1Hand = deck.splice(0, 7);
  let p2Hand = deck.splice(0, 7);
  
  // หาไพ่ใบแรกที่ไม่ใช่ Wild หรือไพ่แกล้งกัน เพื่อเปิดกองกลาง
  let topCardIndex = deck.findIndex(c => c.color !== 'wild' && !['skip','reverse','+2'].includes(c.value));
  if (topCardIndex === -1) topCardIndex = 0;
  let topCard = deck.splice(topCardIndex, 1)[0];

  rooms[roomId].deck = deck;
  rooms[roomId].topCard = topCard;
  rooms[roomId].activeColor = topCard.color; // สีที่ต้องลง
  rooms[roomId].hands = { [rooms[roomId].players[0].id]: p1Hand, [rooms[roomId].players[1].id]: p2Hand };
  rooms[roomId].turnIndex = Math.random() > 0.5 ? 0 : 1;
  rooms[roomId].turnsToTake = 1;
  
  // ฟีเจอร์ Full Option
  rooms[roomId].penaltyCount = 0; // ยอดโดนบวกไพ่สะสม (Stacking)
  rooms[roomId].unoPendingId = null; // เช็คว่าใครต้องกดปุ่ม UNO
  rooms[roomId].winPendingId = null; // เช็คว่าใครต้องกดปุ่ม WIN
  if(rooms[roomId].unoTimer) clearTimeout(rooms[roomId].unoTimer);
  rooms[roomId].unoTimer = null;
  
  rooms[roomId].gameOver = false;
  rooms[roomId].message = `เริ่มเกม UNO! ตาของ ${rooms[roomId].players[rooms[roomId].turnIndex].name}`;
};

// ส่ง State ให้ผู้เล่น
const sendGameState = (roomId) => {
  const room = rooms[roomId];
  if (!room) return;
  room.players.forEach((player, index) => {
    const opponent = room.players[index === 0 ? 1 : 0];
    io.to(player.id).emit('gameState', {
      players: room.players,
      gameType: room.gameType,
      deckCount: room.deck.length,
      topCard: room.topCard,
      activeColor: room.activeColor,
      myHand: room.hands[player.id] || [],
      opponentHandCount: room.hands[opponent.id] ? room.hands[opponent.id].length : 0,
      turnId: room.players[room.turnIndex].id,
      turnName: room.players[room.turnIndex].name,
      turnsToTake: room.turnsToTake,
      penaltyCount: room.penaltyCount,
      unoPendingId: room.unoPendingId,
      winPendingId: room.winPendingId,
      message: room.message,
      gameOver: room.gameOver
    });
  });
};

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ roomId, playerName, gameType }) => {
    if (!rooms[roomId]) rooms[roomId] = { players: [], gameStarted: false, gameType: gameType };
    const room = rooms[roomId];
    if (room.players.length === 0) room.gameType = gameType;
    socket.join(roomId);
    if (!room.players.find(p => p.id === socket.id)) {
      room.players.push({ id: socket.id, name: playerName });
    }
    io.to(roomId).emit('roomStatus', { message: `${playerName} เข้าห้องมาแล้ว!` });
    if (room.players.length === 2 && !room.gameStarted) {
      room.gameStarted = true;
      room.gameType === 'uno' ? setupUnoGame(roomId) : setupBombGame(roomId);
      sendGameState(roomId);
    }
  });

  socket.on('restartGame', (roomId) => {
    if (rooms[roomId] && rooms[roomId].players.length === 2) {
      rooms[roomId].gameType === 'uno' ? setupUnoGame(roomId) : setupBombGame(roomId);
      sendGameState(roomId);
    }
  });

  // จั่วไพ่ หรือยอมรับกรรม (+2/+4)
  socket.on('drawCard', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameOver || room.players[room.turnIndex].id !== socket.id) return;
    const myHand = room.hands[socket.id];
    const myName = room.players[room.turnIndex].name;

    if (room.gameType === 'bomb') {
      const drawnCard = drawFromDeck(room);
      if (drawnCard.type === 'bomb') {
        const defuseIndex = myHand.findIndex(c => c.type === 'defuse');
        if (defuseIndex !== -1) {
          myHand.splice(defuseIndex, 1);
          room.deck.splice(Math.floor(Math.random() * room.deck.length), 0, drawnCard);
          room.message = `หวิดไป! ${myName} ใช้การ์ดง้อกันระเบิด!`;
          if (room.turnsToTake <= 1) { room.turnIndex = room.turnIndex === 0 ? 1 : 0; room.turnsToTake = 1; } 
          else room.turnsToTake -= 1;
        } else {
          room.gameOver = true;
          room.message = `💥 ${myName} เหยียบระเบิด! แพ้แล้ว!`;
        }
      } else {
        myHand.push(drawnCard);
        if (room.turnsToTake <= 1) { room.turnIndex = room.turnIndex === 0 ? 1 : 0; room.turnsToTake = 1; } 
        else room.turnsToTake -= 1;
      }
    } else if (room.gameType === 'uno') {
      // ถ้ามียอดโดน +2 หรือ +4 ค้างอยู่ ต้องจั่วตามยอด
      if (room.penaltyCount > 0) {
        for(let i=0; i<room.penaltyCount; i++) myHand.push(drawFromDeck(room));
        room.message = `🔥 ${myName} ยอมรับกรรม จั่ว ${room.penaltyCount} ใบ!`;
        room.penaltyCount = 0; // ล้างยอด
      } else {
        myHand.push(drawFromDeck(room));
        room.message = `${myName} จั่วไพ่แล้ว`;
      }
      room.turnIndex = room.turnIndex === 0 ? 1 : 0; // จั่วแล้วเปลี่ยนตา
    }
    sendGameState(roomId);
  });

  socket.on('playCard', ({ roomId, cardIndex, selectedColor }) => {
    const room = rooms[roomId];
    if (!room || room.gameOver || room.players[room.turnIndex].id !== socket.id) return;
    
    const myHand = room.hands[socket.id];
    const playedCard = myHand[cardIndex];
    const myName = room.players[room.turnIndex].name;

    if (room.gameType === 'bomb') {
      if (playedCard.type === 'defuse') return;
      myHand.splice(cardIndex, 1);
      if (playedCard.type === 'skip') {
        if (room.turnsToTake <= 1) { room.turnIndex = room.turnIndex === 0 ? 1 : 0; room.turnsToTake = 1; } 
        else room.turnsToTake -= 1;
      } else if (playedCard.type === 'attack') {
        room.turnIndex = room.turnIndex === 0 ? 1 : 0;
        room.turnsToTake = 2;
      } else if (playedCard.type === 'task') {
         io.to(roomId).emit('alert', `📜 ${myName} สั่งภารกิจ: ${playedCard.desc}`);
      }
    } 
    else if (room.gameType === 'uno') {
      // 1. เช็คระบบติดบล็อคทบยอด (+2 ลงทบ +2)
      if (room.penaltyCount > 0) {
        if (playedCard.value !== room.topCard.value) {
           socket.emit('alert', `ต้องลง ${room.topCard.value} ทบยอดเท่านั้น! ไม่งั้นต้องกดจั่วไพ่รับกรรม`);
           return;
        }
      } else {
        // 2. กติกาปกติ
        const colorMatch = playedCard.color === room.activeColor || playedCard.color === 'wild';
        const valueMatch = playedCard.value === room.topCard.value;
        if (!colorMatch && !valueMatch) {
           socket.emit('alert', 'ลงไม่ได้! สีหรือตัวเลขไม่ตรงกับกองกลาง');
           return;
        }
      }

      myHand.splice(cardIndex, 1);
      room.topCard = playedCard;
      room.activeColor = playedCard.color === 'wild' ? selectedColor : playedCard.color;
      
      let nextTurn = room.turnIndex === 0 ? 1 : 0;

      // จัดการการ์ดแกล้งกัน
      if (playedCard.value === 'skip') {
        room.message = `🚫 ${myName} ใช้ Skip! ข้ามตาอีกฝ่าย (ได้เล่นต่อ)`;
        nextTurn = room.turnIndex; // เล่น 2 คน skip = ได้เล่นต่อ
      } else if (playedCard.value === 'reverse') {
        room.message = `🔁 ${myName} ใช้ Reverse!`; // เล่น 2 คน reverse = เปลี่ยนตาปกติ
      } else if (playedCard.value === '+2') {
        room.penaltyCount += 2;
        room.message = `💥 บวก 2! ยอดสะสมตอนนี้: ${room.penaltyCount} ใบ!`;
      } else if (playedCard.value === '+4') {
        room.penaltyCount += 4;
        room.message = `💥 บวก 4! และเปลี่ยนสี! ยอดสะสมตอนนี้: ${room.penaltyCount} ใบ!`;
      } else {
        room.message = `${myName} ลงไพ่ ${room.activeColor} ${playedCard.value}`;
      }

      room.turnIndex = nextTurn;

      // 3. ระบบจับเวลา UNO / WIN (3 วินาที)
      clearTimeout(room.unoTimer);
      if (myHand.length === 1) {
        room.unoPendingId = socket.id;
        room.unoTimer = setTimeout(() => {
          if(rooms[roomId] && rooms[roomId].unoPendingId === socket.id) {
            rooms[roomId].hands[socket.id].push(drawFromDeck(room), drawFromDeck(room));
            rooms[roomId].unoPendingId = null;
            rooms[roomId].message = `⏰ หมดเวลา! ${myName} ลืมกด UNO โดนปรับ +2 ใบ!`;
            sendGameState(roomId);
          }
        }, 3000);
      } else if (myHand.length === 0) {
        room.winPendingId = socket.id;
        room.unoTimer = setTimeout(() => {
          if(rooms[roomId] && rooms[roomId].winPendingId === socket.id) {
            rooms[roomId].hands[socket.id].push(drawFromDeck(room), drawFromDeck(room));
            rooms[roomId].winPendingId = null;
            rooms[roomId].message = `⏰ พลาด! ${myName} ลืมกด UNO WIN โดนปรับ +2 ใบ เกมต่อ!`;
            sendGameState(roomId);
          }
        }, 3000);
      }
    }
    sendGameState(roomId);
  });

  // ปุ่มแก้ทาง UNO (ผู้เล่นกดทันใน 3 วิ)
  socket.on('callUno', (roomId) => {
    const room = rooms[roomId];
    if (room && room.unoPendingId === socket.id) {
      clearTimeout(room.unoTimer);
      room.unoPendingId = null;
      room.message = `🗣️ UNO!! ${room.players.find(p=>p.id===socket.id).name} รอดตัวไป!`;
      sendGameState(roomId);
    }
  });

  // ปุ่มแก้ทาง UNO WIN
  socket.on('callUnoWin', (roomId) => {
    const room = rooms[roomId];
    if (room && room.winPendingId === socket.id) {
      clearTimeout(room.unoTimer);
      room.winPendingId = null;
      room.gameOver = true;
      room.message = `🎉 ชนะแล้ว!! ${room.players.find(p=>p.id===socket.id).name} ไพ่หมดมือ!`;
      sendGameState(roomId);
    }
  });

  // ลบห้องเมื่อคนออก
  socket.on('disconnect', () => {
    console.log('ผู้เล่นออก/ปิดเว็บ:', socket.id);
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        io.to(roomId).emit('error', 'อีกฝ่ายออกจากห้องไปแล้ว (กรุณารีเฟรชเพื่อเข้าใหม่)');
        if (room.players.length === 0) delete rooms[roomId];
      }
    }
  });

});

server.listen(3001, () => console.log('Backend running on port 3001'));