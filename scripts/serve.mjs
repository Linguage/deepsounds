import { createServer } from 'node:http';
import { createHandler, PREFIX } from '../lib/http.js';

const server = createServer(createHandler());
server.listen(Number(process.env.PORT || 7346), '127.0.0.1', () =>
  console.log('deepsounds · http://127.0.0.1:' + server.address().port + PREFIX));
