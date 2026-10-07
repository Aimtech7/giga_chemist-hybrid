import net from 'net';

/**
 * Minimal SMTP server for automated tests only (binds 127.0.0.1). It speaks enough of RFC 5321
 * for nodemailer: EHLO/HELO, MAIL, RCPT, DATA, RSET, NOOP, QUIT. Messages are kept in memory.
 * Modes: accept | tempfail (451 on MAIL) | reject (550 on RCPT). stop() closes the port so the
 * POS server sees a real "connection refused".
 */
export interface FakeMessage {
  from: string;
  to: string[];
  raw: string;
  subject: string;
  receivedAt: number;
}

export type SmtpMode = 'accept' | 'tempfail' | 'reject';

export async function startFakeSmtp(port: number) {
  const messages: FakeMessage[] = [];
  let mode: SmtpMode = 'accept';
  const sockets = new Set<net.Socket>();

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let buf = '';
    let inData = false;
    let from = '';
    let to: string[] = [];
    let data = '';
    const say = (l: string) => sock.write(`${l}\r\n`);
    say('220 fake-smtp.itest ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      while (true) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          const subject = /^Subject: (.*)$/im.exec(data)?.[1]?.trim() || '';
          messages.push({ from, to, raw: data, subject, receivedAt: Date.now() });
          data = '';
          say('250 2.0.0 OK queued');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') sock.write('250-fake-smtp.itest\r\n250-8BITMIME\r\n250 SIZE 52428800\r\n');
        else if (cmd === 'HELO') say('250 fake-smtp.itest');
        else if (cmd === 'MAIL') {
          if (mode === 'tempfail') say('451 4.3.0 Temporary failure, try again later');
          else {
            from = line.replace(/^MAIL FROM:\s*/i, '');
            to = [];
            say('250 OK');
          }
        } else if (cmd === 'RCPT') {
          if (mode === 'reject') say('550 5.1.1 Mailbox unavailable');
          else {
            to.push(line.replace(/^RCPT TO:\s*/i, ''));
            say('250 OK');
          }
        } else if (cmd === 'DATA') {
          inData = true;
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (cmd === 'RSET') say('250 OK');
        else if (cmd === 'NOOP') say('250 OK');
        else if (cmd === 'QUIT') {
          say('221 Bye');
          sock.end();
        } else say('502 Command not implemented');
      }
    });
  });

  const listen = () => new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  await listen();

  return {
    messages,
    setMode(m: SmtpMode) {
      mode = m;
    },
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
    restart: listen,
    async close() {
      if (server.listening) {
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  };
}
