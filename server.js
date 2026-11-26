const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const questions = require('./questions');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ---------- Настройки игры ----------
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;          // чтобы тестировать в одиночку, поставьте 1
const DEFAULT_ROUNDS = 5;       // ведущий может изменить в лобби
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 10;
const ANSWER_SECONDS = 60;
const VOTE_SECONDS = 30;
const POINTS_PER_VOTE = 100;
const MAX_ANSWER_LENGTH = 100;

// code -> { hostId, players:[{id,name,score}], phase, round, question,
//           answers:{id:text}, ballots:[], votes:{id:index}, timer, unused }
// phase: lobby | answering | voting | reveal | final
const rooms = {};

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms[code]);
  return code;
}

function leaderboard(room) {
  return room.players
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function sendLobby(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(room.hostId).emit('lobby:update', room.players.map(p => p.name));
}

function sendAnswerProgress(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(room.hostId).emit('round:progress', {
    answered: Object.keys(room.answers).length,
    total: room.players.length
  });
}

function sendVoteProgress(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(room.hostId).emit('vote:progress', {
    voted: Object.keys(room.votes).length,
    total: room.players.length
  });
}

function pickQuestion(room) {
  if (room.unused.length === 0) room.unused = shuffle(questions);
  return room.unused.pop();
}

// ---------- Раунд: ответы ----------
function startRound(code) {
  const room = rooms[code];
  if (!room) return;
  room.phase = 'answering';
  room.round += 1;
  room.question = pickQuestion(room);
  room.answers = {};
  room.votes = {};
  room.ballots = [];
  io.to(code).emit('round:start', {
    round: room.round,
    totalRounds: room.totalRounds,
    question: room.question,
    seconds: ANSWER_SECONDS
  });
  sendAnswerProgress(code);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endAnswering(code), ANSWER_SECONDS * 1000);
}

function endAnswering(code) {
  const room = rooms[code];
  if (!room || room.phase !== 'answering') return;
  clearTimeout(room.timer);

  // авторов храним только на сервере; на экран и телефоны идут анонимные тексты
  room.ballots = shuffle(
    Object.entries(room.answers).map(([authorId, text]) => {
      const author = room.players.find(p => p.id === authorId);
      return { authorId, authorName: author ? author.name : '???', text, votes: 0 };
    })
  ).map((b, i) => ({ id: i, ...b }));

  if (room.ballots.length < 2) {
    showResults(code); // голосовать не за что
  } else {
    startVoting(code);
  }
}

// ---------- Раунд: голосование ----------
function startVoting(code) {
  const room = rooms[code];
  room.phase = 'voting';
  room.votes = {};

  io.to(room.hostId).emit('vote:start', {
    question: room.question,
    answers: room.ballots.map(b => b.text),
    seconds: VOTE_SECONDS
  });

  // каждому игроку отправляем варианты без его собственного ответа
  room.players.forEach(p => {
    io.to(p.id).emit('vote:start', {
      question: room.question,
      seconds: VOTE_SECONDS,
      options: room.ballots
        .filter(b => b.authorId !== p.id)
        .map(b => ({ index: b.id, text: b.text }))
    });
  });

  sendVoteProgress(code);
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endVoting(code), VOTE_SECONDS * 1000);
}

function endVoting(code) {
  const room = rooms[code];
  if (!room || room.phase !== 'voting') return;
  clearTimeout(room.timer);

  Object.values(room.votes).forEach(index => {
    if (room.ballots[index]) room.ballots[index].votes += 1;
  });
  showResults(code);
}

// ---------- Результаты раунда ----------
function showResults(code) {
  const room = rooms[code];
  if (!room) return;
  room.phase = 'reveal';

  const gains = {};
  room.ballots.forEach(b => {
    const gained = b.votes * POINTS_PER_VOTE;
    gains[b.authorId] = gained;
    const player = room.players.find(p => p.id === b.authorId);
    if (player) player.score += gained;
  });

  const results = room.ballots
    .map(b => ({ text: b.text, author: b.authorName, votes: b.votes, points: b.votes * POINTS_PER_VOTE }))
    .sort((a, b) => b.votes - a.votes);

  io.to(room.hostId).emit('round:results', {
    question: room.question,
    results,
    board: leaderboard(room),
    isLast: room.round >= room.totalRounds
  });

  room.players.forEach(p => {
    io.to(p.id).emit('round:end', { gained: gains[p.id] || 0, score: p.score });
  });
}

function showFinal(code) {
  const room = rooms[code];
  if (!room) return;
  clearTimeout(room.timer);
  room.phase = 'final';

  const board = leaderboard(room);
  io.to(room.hostId).emit('game:final', { board });
  room.players.forEach(p => {
    const rank = 1 + room.players.filter(o => o.score > p.score).length;
    io.to(p.id).emit('game:final', { rank, score: p.score, total: room.players.length });
  });
}

// ---------- Сокеты ----------
io.on('connection', (socket) => {
  socket.on('host:create', () => {
    const code = makeCode();
    rooms[code] = {
      hostId: socket.id, players: [], phase: 'lobby', round: 0, totalRounds: DEFAULT_ROUNDS,
      question: null, answers: {}, ballots: [], votes: {},
      timer: null, unused: shuffle(questions)
    };
    socket.data.code = code;
    socket.data.role = 'host';
    socket.join(code);
    socket.emit('host:created', { code, minPlayers: MIN_PLAYERS, rounds: rooms[code].totalRounds });
  });

  // Ведущий выбирает число раундов (только в лобби)
  socket.on('host:settings', (data) => {
    if (socket.data.role !== 'host') return;
    const room = rooms[socket.data.code];
    if (!room || room.phase !== 'lobby') return;
    const rounds = Number(data && data.rounds);
    if (Number.isInteger(rounds) && rounds >= MIN_ROUNDS && rounds <= MAX_ROUNDS) {
      room.totalRounds = rounds;
      socket.emit('settings:update', { rounds });
    }
  });

  // «Начать игру» (лобби) или «Следующий раунд / Итоги» (после результатов)
  socket.on('host:next', () => {
    if (socket.data.role !== 'host') return;
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;

    if (room.phase === 'lobby') {
      if (room.players.length >= MIN_PLAYERS) startRound(code);
    } else if (room.phase === 'reveal') {
      if (room.round >= room.totalRounds || room.players.length < MIN_PLAYERS) showFinal(code);
      else startRound(code);
    }
  });

  // «Играть снова»: те же игроки, очки обнуляются
  socket.on('host:again', () => {
    if (socket.data.role !== 'host') return;
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.phase !== 'final') return;

    room.phase = 'lobby';
    room.round = 0;
    room.unused = shuffle(questions);
    room.players.forEach(p => { p.score = 0; });
    io.to(code).emit('game:reset');
    sendLobby(code);
  });

  socket.on('player:join', (data, cb) => {
    const code = String((data && data.code) || '').trim().toUpperCase();
    const name = String((data && data.name) || '').trim().slice(0, 16);
    const room = rooms[code];

    if (!room) return cb({ ok: false, error: 'Комната не найдена' });
    if (room.phase !== 'lobby') return cb({ ok: false, error: 'Игра уже идёт' });
    if (!name) return cb({ ok: false, error: 'Введите имя' });
    if (room.players.length >= MAX_PLAYERS) return cb({ ok: false, error: 'Комната заполнена' });
    if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return cb({ ok: false, error: 'Такое имя уже занято' });
    }

    room.players.push({ id: socket.id, name, score: 0 });
    socket.data.code = code;
    socket.data.role = 'player';
    socket.join(code);
    cb({ ok: true, name });
    sendLobby(code);
  });

  socket.on('player:answer', (text, cb) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || socket.data.role !== 'player' || room.phase !== 'answering') return;

    text = String(text || '').trim().slice(0, MAX_ANSWER_LENGTH);
    if (!text) return;
    if (room.answers[socket.id]) return; // один ответ на раунд

    room.answers[socket.id] = text;
    if (typeof cb === 'function') cb({ ok: true });
    sendAnswerProgress(code);

    if (Object.keys(room.answers).length >= room.players.length) endAnswering(code);
  });

  socket.on('player:vote', (index, cb) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || socket.data.role !== 'player' || room.phase !== 'voting') return;
    if (room.votes[socket.id] !== undefined) return; // один голос за раунд

    if (!Number.isInteger(index)) return;
    const ballot = room.ballots[index];
    if (!ballot || ballot.authorId === socket.id) return; // за себя нельзя

    room.votes[socket.id] = index;
    if (typeof cb === 'function') cb({ ok: true });
    sendVoteProgress(code);

    if (Object.keys(room.votes).length >= room.players.length) endVoting(code);
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;

    if (socket.data.role === 'host') {
      clearTimeout(room.timer);
      io.to(code).emit('room:closed');
      delete rooms[code];
      return;
    }

    room.players = room.players.filter(p => p.id !== socket.id);
    delete room.answers[socket.id];
    delete room.votes[socket.id];
    sendLobby(code);

    if (room.phase === 'answering') {
      sendAnswerProgress(code);
      if (room.players.length === 0 || Object.keys(room.answers).length >= room.players.length) {
        endAnswering(code);
      }
    } else if (room.phase === 'voting') {
      sendVoteProgress(code);
      if (room.players.length === 0 || Object.keys(room.votes).length >= room.players.length) {
        endVoting(code);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Сервер запущен: http://localhost:' + PORT));
