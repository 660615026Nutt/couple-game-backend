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

// --- ลอจิกเกม UNO (มินิ) ---
const setupUnoGame = (roomId) => {
  const colors = ['red', 'blue', 'green', 'yellow'];
  let deck = [];
  // สร้างไพ่สีละ 1-9 อย่างละ 2 ใบ
  colors.forEach(color => {
    for(let i=1; i<=9; i++) {
      deck.push({ type: 'uno', color: color, value: i, name: `${i}` });
      deck.push({ type: 'uno', color: color, value: i, name: `${i}` });
    }
  });
  deck = shuffleArray(deck);

  let p1Hand = deck.splice(0, 7); // แจกคนละ 7 ใบ
  let p2Hand = deck.splice(0, 7);
  let topCard = deck.shift(); // เปิดไพ่ใบแรกตรงกลาง

  rooms[roomId].deck = deck;
  rooms[roomId].topCard = topCard;
  rooms[roomId].hands = { [rooms[roomId].players[0].id]: p1Hand, [rooms[roomId].players[1].id]: p2Hand };
  rooms[roomId].turnIndex = Math.random() > 0.5 ? 0 : 1;
  rooms[roomId].turnsToTake = 1;
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
      topCard: room.topCard, // สำหรับ UNO
      myHand: room.hands[player.id] || [],
      opponentHandCount: room.hands[opponent.id] ? room.hands[opponent.id].length : 0,
      turnId: room.players[room.turnIndex].id,
      turnName: room.players[room.turnIndex].name,
      turnsToTake: room.turnsToTake,
      message: room.message,
      gameOver: room.gameOver
    });
  });
};

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ roomId, playerName, gameType }) => {
    if (!rooms[roomId]) rooms[roomId] = { players: [], gameStarted: false, gameType: gameType };
    const room = rooms[roomId];
    
    // อัปเดตประเภทเกมหากคนแรกสร้างไว้
    if (room.players.length === 0) room.gameType = gameType;

    socket.join(roomId);
    if (!room.players.find(p => p.id === socket.id)) {
      room.players.push({ id: socket.id, name: playerName });
    }
    io.to(roomId).emit('roomStatus', { message: `${playerName} เข้าห้องมาแล้ว!` });

    if (room.players.length === 2) {
      room.gameStarted = true;
      if(room.gameType === 'uno') setupUnoGame(roomId);
      else setupBombGame(roomId);
      sendGameState(roomId);
    }
  });

  // ระบบปุ่ม "เริ่มเกมใหม่"
  socket.on('restartGame', (roomId) => {
    const room = rooms[roomId];
    if (room && room.players.length === 2) {
      if(room.gameType === 'uno') setupUnoGame(roomId);
      else setupBombGame(roomId);
      sendGameState(roomId);
    }
  });

  socket.on('drawCard', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameOver || room.players[room.turnIndex].id !== socket.id) return;

    const drawnCard = room.deck.shift();
    const myHand = room.hands[socket.id];
    const myName = room.players[room.turnIndex].name;

    if (room.gameType === 'bomb') {
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
      myHand.push(drawnCard);
      room.message = `${myName} จั่วไพ่แล้ว`;
      room.turnIndex = room.turnIndex === 0 ? 1 : 0; // จั่วแล้วเปลี่ยนตา
    }
    
    // รีสับกองไพ่ถ้าไพ่หมด (สำหรับ UNO)
    if(room.deck.length === 0 && room.gameType === 'uno') {
      room.deck = shuffleArray([{ type:'uno', color:'red', value:1 }]); // แจกปลอมๆ กันพัง
    }

    sendGameState(roomId);
  });

  socket.on('playCard', ({ roomId, cardIndex }) => {
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
      const top = room.topCard;
      // ลอจิก UNO: สีเหมือนกัน หรือ เลขเหมือนกัน ถึงจะลงได้
      if (playedCard.color === top.color || playedCard.value === top.value) {
        room.topCard = playedCard; // เปลี่ยนไพ่กองกลาง
        myHand.splice(cardIndex, 1); // เอาไพ่ออกจากมือ
        
        if (myHand.length === 0) {
          room.gameOver = true;
          room.message = `🎉 ${myName} ไพ่หมดมือ! ชนะแล้ว!`;
        } else {
          room.message = `${myName} ลงไพ่ ${playedCard.color} ${playedCard.value}`;
          room.turnIndex = room.turnIndex === 0 ? 1 : 0; // เปลี่ยนตา
        }
      } else {
         socket.emit('alert', 'ลงไม่ได้! สีหรือตัวเลขไม่ตรงกับกองกลาง');
         return; // หยุดการทำงาน ไม่ส่ง state
      }
    }

    sendGameState(roomId);
  });
});

server.listen(3001, () => console.log('Backend running on http://localhost:3001'));