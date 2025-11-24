// Servidor HTTP para o Render (mantém o serviço ativo)
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/healthz", (req, res) => {
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Cache-Control", "no-cache");
  res.status(200).send("ok");
});

app.get("/ping", (req, res) => res.send("pong"));



app.listen(PORT, () => {
  console.log("Health server rodando na porta", PORT);
});



// server.js
const admin = require('firebase-admin');

// Lê service account da variável de ambiente FIREBASE_SERVICE_ACCOUNT (JSON string)
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("ERRO: defina a variável FIREBASE_SERVICE_ACCOUNT com o JSON da service account.");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error("ERRO: FIREBASE_SERVICE_ACCOUNT não é um JSON válido.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

// Mapa em memória para guardar scores atuais: { uid: score }
const scores = new Map();

async function initScores() {
  console.log("Carregando scores iniciais...");
  const snap = await db.collection('leaderboard').get();
  snap.forEach(doc => {
    const data = doc.data();
    scores.set(doc.id, typeof data.score === 'number' ? data.score : 0);
  });
  console.log("Scores iniciais carregados. Total:", scores.size);
}

async function removeInvalidTokens(uid, invalidTokens) {
  try {
    if (!Array.isArray(invalidTokens) || invalidTokens.length === 0) return;
    console.log(`Removendo tokens inválidos para ${uid}:`, invalidTokens);
    await db.collection('users').doc(uid).update({
      tokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens)
    });
  } catch (err) {
    console.error("Falha ao remover tokens inválidos:", err);
  }
}

async function sendNotificationAndCleanup(uid, tokens, title, body) {
  if (!tokens || tokens.length === 0) return;

  try {
    const messages = tokens.map(token => ({
      token: token,
      notification: {
        title: title,
        body: body
      }
    }));

    // FCM v1 doesn't support batch on server, so send sequentially
    const results = [];

    for (const msg of messages) {
      try {
        await messaging.send(msg);
        results.push({ success: true });
      } catch (err) {
        results.push({ success: false, error: err });
      }
    }

    const invalidTokens = [];
    results.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.errorInfo?.code;

        if (code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token") {
          invalidTokens.push(tokens[i]);
        }
      }
    });

    if (invalidTokens.length > 0) {
      console.log("Removendo tokens inválidos:", invalidTokens);
      await removeInvalidTokens(uid, invalidTokens);
    }

    console.log(
      `FCM v1 OK — Sucesso: ${results.filter(r => r.success).length} | Falha: ${results.filter(r => !r.success).length}`
    );

  } catch (e) {
    console.error("Erro FCM v1 final:", e);
  }
}



async function startListener() {
  await initScores();

  console.log("Iniciando listener da coleção leaderboard...");
  db.collection('leaderboard').onSnapshot(async snapshot => {
    // docChanges contém as alterações desde o último snapshot
    for (const change of snapshot.docChanges()) {
      const doc = change.doc;
      const uid = doc.id;
      const data = doc.data();
      const newScore = typeof data.score === 'number' ? data.score : 0;
      const name = data.name || 'Alguém';

      const oldScore = scores.has(uid) ? scores.get(uid) : 0;

      // Atualiza o mapa com o novo score imediatamente
      scores.set(uid, newScore);

      // Queremos apenas aumentos
      if (newScore <= oldScore) continue;

      console.log(`${name} (${uid}) aumentou de ${oldScore} para ${newScore}`);

      // Busca quem foi ultrapassado
      // Condition: score < newScore AND score >= oldScore
      const overtakenSnap = await db.collection('leaderboard')
        .where('score', '<', newScore)
        .where('score', '>=', oldScore)
        .get();

      if (overtakenSnap.empty) {
        console.log("Ninguém ultrapassado nesse aumento.");
        continue;
      }

      for (const overtakenDoc of overtakenSnap.docs) {
        const targetUid = overtakenDoc.id;
        if (targetUid === uid) continue;

        const userDoc = await db.collection('users').doc(targetUid).get();
        if (!userDoc.exists) continue;

        const userData = userDoc.data();
        const tokens = Array.isArray(userData.tokens) ? userData.tokens : [];

        if (tokens.length === 0) continue;

        const title = "Você foi ultrapassado!";
        const body = `${name} te passou com ${newScore} pontos.`;

        await sendNotificationAndCleanup(targetUid, tokens, title, body);
      }
    }
  }, err => {
    console.error("Listener erro:", err);
    process.exit(1);
  });
}

// Start
startListener().catch(err => {
  console.error("Erro no startListener:", err);
  process.exit(1);
});
