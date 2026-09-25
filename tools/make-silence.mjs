/*
 * SpotiDuck — génère `android/app/src/main/assets/silent.mp3`.
 *
 * À quoi ça sert : quand Spotify sert une **publicité audio**, le lecteur attend
 * un flux audio. Répondre « rien » (ce que fait un simple blocage) laisse le
 * lecteur devant un fichier manquant ; répondre **du silence** lui donne ce
 * qu'il attend, sans que l'utilisateur entende la publicité. C'est ce que fait
 * l'application d'origine (`assets/silent.mp3` + remplacement à la volée) et
 * c'est ce qu'on reprend ici.
 *
 * Le fichier est commité : cette fabrique ne sert qu'à le refaire. Elle demande
 * `lamejs`, un encodeur MP3 en JavaScript (dev uniquement, pas une dépendance
 * de l'application) :
 *
 *   npm install --no-save lamejs && node tools/make-silence.mjs
 *
 * Réglages : 30 secondes, 22,05 kHz, mono, 24 kbit/s — assez long pour couvrir
 * un écran publicitaire, assez petit (≈ 90 ko) pour tenir dans l'APK.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
let lamejs;
try {
  /* Le paquet npm n'est pas un module : son entrée (`src/js/index.js`) attend
     des variables globales et se casse sous Node. `lame.all.js` est la version
     navigateur, qui définit tout et s'appelle elle-même — on l'exécute donc
     dans un contexte isolé, et on récupère l'encodeur qu'elle y laisse. */
  const source = readFileSync(require.resolve("lamejs/lame.all.js"), "utf8");
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(source, sandbox);
  lamejs = sandbox.lamejs;
  if (!lamejs || typeof lamejs.Mp3Encoder !== "function") throw new Error("encodeur introuvable");
} catch (e) {
  console.error("lamejs indisponible (" + e.message + ") : npm install --no-save lamejs");
  process.exit(1);
}

const SAMPLE_RATE = 22050;
const BITRATE = 24;
const SECONDS = 30;
const CHUNK = 1152; // taille de bloc attendue par lamejs

const encoder = new lamejs.Mp3Encoder(1, SAMPLE_RATE, BITRATE);
const samples = new Int16Array(CHUNK); // zéros = silence
const chunks = [];
const total = Math.round(SAMPLE_RATE * SECONDS);

for (let done = 0; done < total; done += CHUNK) {
  const buffer = encoder.encodeBuffer(samples);
  if (buffer.length) chunks.push(Buffer.from(buffer));
}
const flush = encoder.flush();
if (flush.length) chunks.push(Buffer.from(flush));

const mp3 = Buffer.concat(chunks);
writeFileSync("android/app/src/main/assets/silent.mp3", mp3);
console.log(
  `silence écrit : ${mp3.length} octets · ${SECONDS} s · ${SAMPLE_RATE} Hz mono ${BITRATE} kbit/s · ` +
    `en-tête ${mp3.subarray(0, 2).toString("hex")}`
);
