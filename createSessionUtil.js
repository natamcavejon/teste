"use strict";var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");Object.defineProperty(exports, "__esModule", { value: true });exports.default = void 0;














var _sessionUtil = require("./sessionUtil");
var _wppconnect = require("@wppconnect-team/wppconnect");
var _functions = require("./functions");
var _sessionController = require("../controller/sessionController");
var _factory = _interopRequireDefault(require("./tokenStore/factory"));
var _chatWootClient = _interopRequireDefault(require("./chatWootClient"));
var _fs = _interopRequireDefault(require("fs"));
var _request = _interopRequireDefault(require("request")); /*
 * Copyright 2021 WPPConnect Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */class CreateSessionUtil {startChatWootClient(client) {if (client.config.chatWoot && !client._chatWootClient) client._chatWootClient = new _chatWootClient.default(client.config.chatWoot, client.session);return client._chatWootClient;}async createSessionUtil(req, clientsArray, session, res) {try {let client = this.getClient(session);if (client.status != null && client.status !== 'CLOSED') return;client.status = 'INITIALIZING';client.config = req.body;

      const tokenStore = new _factory.default();
      const myTokenStore = tokenStore.createTokenStory(client);

      await myTokenStore.getToken(session);
      this.startChatWootClient(client);

      if (req.serverOptions.customUserDataDir) {
        req.serverOptions.createOptions.puppeteerOptions = {
          userDataDir: req.serverOptions.customUserDataDir + session
        };
      }

      let wppClient = await (0, _wppconnect.create)(
      Object.assign({}, { tokenStore: myTokenStore }, req.serverOptions.createOptions, {
        session: session,
        deviceName: req.serverOptions.deviceName,
        poweredBy: req.serverOptions.poweredBy || 'WPPConnect-Server',
        catchQR: (base64Qr, asciiQR, attempt, urlCode) => {
          this.exportQR(req, base64Qr, urlCode, client, res);
        },
        onLoadingScreen: (percent, message) => {
          req.logger.info(`[${session}] ${percent}% - ${message}`);
        },
        statusFind: (statusFind) => {
          try {
            _sessionUtil.eventEmitter.emit(`status-${client.session}`, client, statusFind);
            if (statusFind === 'autocloseCalled' || statusFind === 'desconnectedMobile') {
              client.status = 'CLOSED';
              client.qrcode = null;
              client.close();
              clientsArray[session] = undefined;
            }
            (0, _functions.callWebHook)(client, req, 'status-find', { status: statusFind });
            req.logger.info(statusFind + '\n\n');
          } catch (error) {}
        }
      }));


      client = clientsArray[session] = Object.assign(wppClient, client);
      await this.start(req, client);

      if (req.serverOptions.webhook.onParticipantsChanged) {
        await this.onParticipantsChanged(req, client);
      }

      if (req.serverOptions.webhook.onReactionMessage) {
        await this.onReactionMessage(client, req);
      }

      if (req.serverOptions.webhook.onRevokedMessage) {
        await this.onRevokedMessage(client, req);
      }

      if (req.serverOptions.webhook.onPollResponse) {
        await this.onPollResponse(client, req);
      }
    } catch (e) {
      req.logger.error(e);
    }
  }

  async opendata(req, session, res) {
    await this.createSessionUtil(req, _sessionUtil.clientsArray, session, res);
  }

  exportQR(req, qrCode, urlCode, client, res) {
    _sessionUtil.eventEmitter.emit(`qrcode-${client.session}`, qrCode, urlCode, client);
    Object.assign(client, {
      status: 'QRCODE',
      qrcode: qrCode,
      urlcode: urlCode
    });

    qrCode = qrCode.replace('data:image/png;base64,', '');
    const imageBuffer = Buffer.from(qrCode, 'base64');

    req.io.emit('qrCode', {
      data: 'data:image/png;base64,' + imageBuffer.toString('base64'),
      session: client.session
    });

    (0, _functions.callWebHook)(client, req, 'qrcode', { qrcode: qrCode, urlcode: urlCode });
    if (res && !res._headerSent) res.status(200).json({ status: 'qrcode', qrcode: qrCode, urlcode: urlCode });
  }

  async onParticipantsChanged(req, client) {
    await client.isConnected();
    await client.onParticipantsChanged((message) => {
      (0, _functions.callWebHook)(client, req, 'onparticipantschanged', message);
    });
  }

  async start(req, client) {
    try {
      await client.isConnected();
      Object.assign(client, { status: 'CONNECTED', qrcode: null });

      req.logger.info(`Started Session: ${client.session}`);
      //callWebHook(client, req, 'session-logged', { status: 'CONNECTED'});
      req.io.emit('session-logged', { status: true, session: client.session });
      (0, _functions.startHelper)(client, req);
    } catch (error) {
      req.logger.error(error);
      req.io.emit('session-error', client.session);
    }

    await this.checkStateSession(client, req);
    await this.listenMessages(client, req);

    if (req.serverOptions.webhook.listenAcks) {
      await this.listenAcks(client, req);
    }

    if (req.serverOptions.webhook.onPresenceChanged) {
      await this.onPresenceChanged(client, req);
    }
  }

  async checkStateSession(client, req) {
    await client.onStateChange((state) => {
      req.logger.info(`State Change ${state}: ${client.session}`);
      const conflits = [_wppconnect.SocketState.CONFLICT];

      if (conflits.includes(state)) {
        client.useHere();
      }
    });
  }

  async listenMessages(client, req) {
    await client.onMessage(async (message) => {
      _fs.default.writeFile('message.txt', `{body: ${message.body}, WaId: ${message.from}, AccountSid: ${message.chatId}, Message:${JSON.stringify(message)}`, (err) => {if (err) throw err;
        console.log('Mensagem Salva');});

      var url = `https://enviae-bot.herokuapp.com/whatsapp/recivedmessages/${client.session}`;
      var options = {
        'method': 'POST',
        'url': url,
        json: message
      };
      (0, _request.default)(options, function (error, response) {
        if (error) {
          throw err;
        } else {
          _fs.default.writeFile('messageret.txt', `{body: ${message.body}, mensagem enviada a API com sucesso}`, (err) => {
            if (err) throw err;
            console.log('Enviado API');
          });
        }
      });
      _sessionUtil.eventEmitter.emit(`mensagem-${client.session}`, client, message);
      (0, _functions.callWebHook)(client, req, 'onmessage', message);
      if (message.type === 'location')
      client.onLiveLocation(message.sender.id, (location) => {
        (0, _functions.callWebHook)(client, req, 'location', location);
      });
    });

    await client.onAnyMessage((message) => {
      message.session = client.session;

      if (message.type === 'sticker') {
        (0, _sessionController.download)(message, client, req.logger);
      }

      req.io.emit('received-message', { response: message });
    });

    await client.onIncomingCall(async (call) => {
      req.io.emit('incomingcall', call);
      (0, _functions.callWebHook)(client, req, 'incomingcall', call);
    });
  }

  async listenAcks(client, req) {
    await client.onAck(async (ack) => {
      req.io.emit('onack', ack);
      (0, _functions.callWebHook)(client, req, 'onack', ack);
    });
  }

  async onPresenceChanged(client, req) {
    await client.onPresenceChanged(async (presenceChangedEvent) => {
      req.io.emit('onpresencechanged', presenceChangedEvent);
      (0, _functions.callWebHook)(client, req, 'onpresencechanged', presenceChangedEvent);
    });
  }

  async onReactionMessage(client, req) {
    await client.isConnected();
    await client.onReactionMessage(async (reaction) => {
      req.io.emit('onreactionmessage', reaction);
      (0, _functions.callWebHook)(client, req, 'onreactionmessage', reaction);
    });
  }

  async onRevokedMessage(client, req) {
    await client.isConnected();
    await client.onRevokedMessage(async (response) => {
      req.io.emit('onrevokedmessage', response);
      (0, _functions.callWebHook)(client, req, 'onrevokedmessage', response);
    });
  }
  async onPollResponse(client, req) {
    await client.isConnected();
    await client.onPollResponse(async (response) => {
      req.io.emit('onpollresponse', response);
      (0, _functions.callWebHook)(client, req, 'onpollresponse', response);
    });
  }

  encodeFunction(data, webhook) {
    data.webhook = webhook;
    return JSON.stringify(data);
  }

  decodeFunction(text, client) {
    let object = JSON.parse(text);
    if (object.webhook && !client.webhook) client.webhook = object.webhook;
    delete object.webhook;
    return object;
  }

  getClient(session) {
    let client = _sessionUtil.clientsArray[session];

    if (!client) client = _sessionUtil.clientsArray[session] = { status: null, session: session };
    return client;
  }
}exports.default = CreateSessionUtil;
//# sourceMappingURL=createSessionUtil.js.map