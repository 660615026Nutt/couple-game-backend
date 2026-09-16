const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

// ตั้งค่า Socket.IO ให้ยอมรับการเชื่อมต่อจาก React (ที่มักจะรันบนพอร์ต 5173)
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// เก็บข้อมูลห้องเกมทั้งหมด
const rooms = {};

// ฟังก์ชันสับไพ่
const shuffleArray = (array) => {
  let shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

// ฟังก์ชันเริ่มเกมและแจกไพ่
const setupGame = (roomId) => {
  let baseCards = [];
  for (let i = 0; i < 6; i++) baseCards.push({ type: 'skip', name: '⏭️ ชิ่งหนี' });
  for (let i = 0; i < 6; i++) baseCards.push({ type: 'attack', name: '⚔️ โจมตี' });
  for (let i = 0; i < 4; i++) baseCards.push({ type: 'see', name: '👁️ แอบดูกอง' });
  for (let i = 0; i < 5; i++) baseCards.push({ type: 'task', name: '📜 ภารกิจ', desc: 'สั่งให้อีกฝ่ายทำตามใจชอบ!' });
  baseCards.push({ type: 'attack', name: '🐉 โครโน่เจ็ท ดราก้อน', desc: 'บังคับอีกฝ่ายเล่น 2 ตา!' });

  baseCards = shuffleArray(baseCards);

  // แจกไพ่ให้ผู้เล่น 2 คน คนละ 4 ใบ
  let p1Hand = baseCards.splice(0, 4);
  let p2Hand = baseCards.splice(0, 4);

  // ยัดการ์ดป้องกันให้คนละ 1 ใบ
  p1Hand.push({ type: 'defuse', name: '🛡️ การ์ดง้อ' });
  p2Hand.push({ type: 'defuse', name: '🛡️ การ์ดง้อ' });

  // ใส่ระเบิด 1 การ์ดง้อ 1 ลงกองกลางแล้วสับใหม่
  baseCards.push({ type: 'defuse', name: '🛡️ การ์ดง้อ' });
  baseCards.push({ type: 'bomb', name: '💣 ระเบิดความงอน' });
  baseCards = shuffleArray(baseCards);

  // กำหนดว่าใครเริ่มก่อน (0 หรือ 1)
  const firstTurnIndex = Math.random() > 0.5 ? 0 : 1;

  rooms[roomId] = {
    ...rooms[roomId],
    deck: baseCards,
    hands: {
      [rooms[roomId].players[0].id]: shuffleArray(p1Hand),
      [rooms[roomId].players[1].id]: shuffleArray(p2Hand)
    },
    turnIndex: firstTurnIndex,
    turnsToTake: 1,
    gameOver: false,
    message: `เกมเริ่มแล้ว! ตาของ ${rooms[roomId].players[firstTurnIndex].name}`
  };
};

// ฟังก์ชันส่งข้อมูลให้ผู้เล่นแต่ละคน (ซ่อนไพ่คู่แข่ง)
const sendGameState = (roomId) => {
  const room = rooms[roomId];
  if (!room) return;

  room.players.forEach((player, index) => {
    const opponent = room.players[index === 0 ? 1 : 0];
    const myHand = room.hands[player.id] || [];
    const opponentHandCount = room.hands[opponent.id] ? room.hands[opponent.id].length : 0;
    const activePlayer = room.players[room.turnIndex];

    io.to(player.id).emit('gameState', {
      players: room.players,
      deckCount: room.deck.length,
      myHand: myHand,
      opponentHandCount: opponentHandCount,
      turnId: activePlayer.id,
      turnName: activePlayer.name,
      turnsToTake: room.turnsToTake,
      message: room.message,
      gameOver: room.gameOver
    });
  });
};

// เมื่อมีคนเชื่อมต่อเข้ามา
io.on('connection', (socket) => {
  console.log('มีผู้เล่นเชื่อมต่อ:', socket.id);

  // 1. รับคำสั่งเข้าห้อง
  socket.on('joinRoom', ({ roomId, playerName }) => {
    if (!rooms[roomId]) {
      rooms[roomId] = { players: [], gameStarted: false };
    }

    const room = rooms[roomId];
    
    // ถ้าห้องเต็ม (มี 2 คนแล้ว)
    if (room.players.length >= 2 && !room.players.find(p => p.id === socket.id)) {
      socket.emit('error', 'ห้องนี้เต็มแล้วครับ!');
      return;
    }

    // เอาผู้เล่นเข้าห้อง
    socket.join(roomId);
    if (!room.players.find(p => p.id === socket.id)) {
      room.players.push({ id: socket.id, name: playerName });
    }

    io.to(roomId).emit('roomStatus', { 
      players: room.players, 
      message: `${playerName} เข้าห้องมาแล้ว! รออีกฝ่าย...`
    });

    // ถ้าคนครบ 2 คน เริ่มเกมเลย!
    if (room.players.length === 2 && !room.gameStarted) {
      room.gameStarted = true;
      setupGame(roomId);
      sendGameState(roomId);
    }
  });

  // 2. รับคำสั่งจั่วไพ่
  socket.on('drawCard', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameOver || room.players[room.turnIndex].id !== socket.id) return;

    const drawnCard = room.deck.shift();
    const myHand = room.hands[socket.id];
    const myName = room.players[room.turnIndex].name;

    if (drawnCard.type === 'bomb') {
      const defuseIndex = myHand.findIndex(c => c.type === 'defuse');
      if (defuseIndex !== -1) {
        myHand.splice(defuseIndex, 1); // หักการ์ดป้องกัน
        const insertIndex = Math.floor(Math.random() * (room.deck.length + 1));
        room.deck.splice(insertIndex, 0, drawnCard); // ยัดระเบิดกลับ
        room.message = `หวิดไปแล้ว! ${myName} จั่วโดนระเบิด แต่ใช้การ์ดง้อป้องกันไว้ได้!`;
        
        // จบเทิร์น
        if (room.turnsToTake <= 1) {
          room.turnIndex = room.turnIndex === 0 ? 1 : 0;
          room.turnsToTake = 1;
        } else {
          room.turnsToTake -= 1;
        }
      } else {
        room.gameOver = true;
        const winner = room.players[room.turnIndex === 0 ? 1 : 0].name;
        room.message = `💥 บึ้มมม! ${myName} เหยียบระเบิด! (${winner} ชนะ!)`;
      }
    } else {
      myHand.push(drawnCard);
      room.message = `${myName} จั่วการ์ดไปแล้ว`;
      if (room.turnsToTake <= 1) {
        room.turnIndex = room.turnIndex === 0 ? 1 : 0;
        room.turnsToTake = 1;
      } else {
        room.turnsToTake -= 1;
      }
    }
    
    sendGameState(roomId);
  });

  // 3. รับคำสั่งใช้ไพ่ (Action)
  socket.on('playCard', ({ roomId, cardIndex }) => {
    const room = rooms[roomId];
    if (!room || room.gameOver || room.players[room.turnIndex].id !== socket.id) return;

    const myHand = room.hands[socket.id];
    const playedCard = myHand[cardIndex];
    const myName = room.players[room.turnIndex].name;

    if (playedCard.type === 'defuse') return; // ห้ามกดใช้เอง

    myHand.splice(cardIndex, 1); // ลบไพ่ออกจากมือ

    if (playedCard.type === 'skip') {
      room.message = `${myName} ใช้การ์ดชิ่งหนี!`;
      if (room.turnsToTake <= 1) {
        room.turnIndex = room.turnIndex === 0 ? 1 : 0;
        room.turnsToTake = 1;
      } else {
        room.turnsToTake -= 1;
      }
    } else if (playedCard.type === 'attack') {
      room.message = `${myName} โจมตี! อีกฝ่ายโดนบังคับเล่น 2 ตาติด`;
      room.turnIndex = room.turnIndex === 0 ? 1 : 0; // โยนให้อีกฝ่าย
      room.turnsToTake = 2; // บังคับ 2 ตา
    } else if (playedCard.type === 'see') {
      const top3 = room.deck.slice(0, 3).map(c => c.name).join(', ');
      // ส่งแอบดูไปให้คนกดใช้แค่คนเดียว
      socket.emit('alert', `👁️ 3 ใบบนสุดคือ: ${top3 || 'ไม่มีการ์ด'}`);
      room.message = `${myName} แอบดูกองไพ่!`;
    } else if (playedCard.type === 'task') {
      io.to(roomId).emit('alert', `📜 ${myName} ใช้การ์ดภารกิจ: ${playedCard.desc}`);
      room.message = `${myName} โยนภารกิจให้อีกฝ่าย!`;
    }

    sendGameState(roomId);
  });

  socket.on('disconnect', () => {
    console.log('ผู้เล่นออก:', socket.id);
    // ในโปรเจกต์จริง ต้องมีการจัดการลบคนออกจากห้องเมื่อเน็ตหลุด
  });
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`Backend วิ่งอยู่ที่ http://localhost:${PORT}`);
});