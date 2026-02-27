#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

import { Device } from '../lib/index.mjs';
import express from 'express';
import getPort from 'get-port';
import getLocalIp from '@loxjs/node-local-ip';
import { v4 as uuidv4 } from 'uuid';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const deviceOptions = yargs => yargs
  .option('host', {
    required: true,
    type: 'string',
    describe: 'Display IP address',
  })
  .option('pin', {
    required: true,
    type: 'string',
    describe: 'e.g. 000000',
  })
  .option('mac', {
    required: false,
    type: 'string',
    describe: 'MAC address (for Wake-on-LAN)',
  });

yargs(hideBin(process.argv))
  .command({
    command: 'show-image',
    describe: 'Show an image on Samsung EMDX display',
    builder: yargs => deviceOptions(yargs)
      .option('image', {
        type: 'string',
        describe: 'Path to the image file',
        required: true,
      })
      .option('local-ip', {
        required: false,
        type: 'string',
        describe: 'Local IP address to use for the server',
        default: getLocalIp(),
      })
      .option('sleep-after', {
        type: 'number',
        describe: 'Minutes of inactivity before powering off (0 = never)',
        default: 0,
      }),
    handler: async (argv) => {
      const { host, mac, pin, localIp, sleepAfter } = argv;
      const image = path.resolve(argv.image);

      if (!fs.existsSync(image)) {
        console.error(`❌ Image file not found: ${image}`);
        process.exit(1);
      }

      const port = await getPort({ port: 3000 });
      const fileId = uuidv4().toUpperCase();
      const fileSize = await fs.promises.stat(image).then(stats => stats.size);
      const fileExtension = path.extname(image).slice(1);
      const fileName = `${fileId}.${fileExtension}`;

      console.log(`Image: ${image} (${fileSize} bytes)`);
      console.log(`Display: ${host}`);
      if (sleepAfter > 0) console.log(`Sleep after: ${sleepAfter} minutes`);
      console.log('');

      console.log('🔄 Starting HTTP server...');
      const server = await new Promise((resolve, reject) => {
        const app = express()
          .get('/content.json', (req, res) => {
            console.log('🔄 Serving /content.json...');

            res.header('Content-Type', 'application/json');
            res.send(JSON.stringify({
              schedule: [
                {
                  start_date: '1970-01-01',
                  stop_date: '2999-12-31',
                  start_time: '00:00:00',
                  contents: [
                    {
                      image_url: `http://${localIp}:${port}/image`,
                      file_id: fileId,
                      file_path: `/home/owner/content/Downloads/vxtplayer/epaper/mobile/contents/${fileId}/${fileName}`,
                      duration: 91326,
                      file_size: `${fileSize}`,
                      file_name: `${fileName}`,
                    },
                  ],
                },
              ],
              name: 'node-samsung-emdx',
              version: 1,
              create_time: '2025-01-01 00:00:00',
              id: fileId,
              program_id: 'com.samsung.ios.ePaper',
              content_type: 'ImageContent',
              deploy_type: 'MOBILE'
            }).replaceAll('/', '\\/'));

            req.once('close', () => {
              console.log('✅ Served /content.json');
              console.log('');
            });
          })
          .get(`/image`, (req, res) => {
            console.log(`🔄 Serving /image...`);
            res.sendFile(image);

            req.once('close', () => {
              console.log(`✅ Served /image`);
              console.log('');

              if (sleepAfter > 0) {
                console.log(`⏰ Display will sleep in ${sleepAfter} minutes...`);
                setTimeout(async () => {
                  console.log('');
                  console.log('💤 Sleep timer fired — powering off display...');
                  try {
                    const sleepDevice = new Device({ host, mac, pin });
                    await sleepDevice.connect();
                    await sleepDevice.setNetworkStandby({ enabled: false }).catch(() => {});
                    console.log('📡 Network standby disabled (true deep sleep)');
                    await sleepDevice.setPower({ power: false });
                    await sleepDevice.disconnect();
                    console.log('✅ Display powered off — use WoL to wake');
                  } catch (err) {
                    console.error(`❌ Failed to power off: ${err.message}`);
                  }
                  process.exit(0);
                }, sleepAfter * 60_000);
              } else {
                setTimeout(() => process.exit(0), 500);
              }
            });
          });

        const srv = app.listen(port, () => resolve(srv));
        srv.on('error', reject);
      });
      console.log(`✅ HTTP server listening at http://${localIp}:${port}`);
      console.log('');

      try {
        const device = new Device({ host, mac, pin });

        if (mac) {
          console.log('🔄 Waking up device...');
          await device.wakeup();
          await new Promise(resolve => setTimeout(resolve, 1000));
          console.log('✅ Device woken up');
          console.log('');
        }

        console.log('🔄 Connecting...');
        await device.connect();
        await device.setNetworkStandby({ enabled: true }).catch(() => {});
        console.log('✅ Connected');
        console.log('');

        const url = `http://${localIp}:${port}/content.json`;
        console.log(`🔄 Setting content to ${url}...`);
        await device.setContentDownload({ url });
        await device.disconnect();
        console.log('✅ Content set');
        console.log('');

        console.log('⏳ Waiting for display to download image...');
      } catch (err) {
        server.close();
        console.error(`❌ ${err.message}`);
        process.exit(1);
      }
    },
  })
  .command({
    command: 'wake',
    describe: 'Wake the display via Wake-on-LAN',
    builder: yargs => yargs
      .option('mac', {
        required: true,
        type: 'string',
        describe: 'MAC address',
      }),
    handler: async (argv) => {
      const device = new Device({ mac: argv.mac });
      console.log(`🔄 Sending Wake-on-LAN to ${argv.mac}...`);
      await device.wakeup();
      console.log('✅ Magic packet sent');
    },
  })
  .command({
    command: 'sleep',
    describe: 'Power off the display',
    builder: deviceOptions,
    handler: async (argv) => {
      const device = new Device({ host: argv.host, pin: argv.pin, mac: argv.mac });
      console.log(`🔄 Connecting to ${argv.host}...`);
      await device.connect();
      await device.setNetworkStandby({ enabled: false }).catch(() => {});
      console.log('📡 Network standby disabled');
      console.log('💤 Powering off...');
      await device.setPower({ power: false });
      await device.disconnect();
      console.log('✅ Display powered off — use WoL to wake');
    },
  })
  .command({
    command: 'status',
    describe: 'Get display status (power, battery, info)',
    builder: deviceOptions,
    handler: async (argv) => {
      const device = new Device({ host: argv.host, pin: argv.pin, mac: argv.mac });
      console.log(`🔄 Connecting to ${argv.host}...`);
      await device.connect();

      const power = await device.getPowerState().catch(() => 'Unknown');
      console.log(`Power:    ${power}`);

      try {
        const battery = await device.getBatteryState();
        console.log(`Battery:  ${battery.level}%${battery.charging ? ' (charging)' : ''}${battery.healthy ? '' : ' (unhealthy)'}`);
      } catch {
        console.log('Battery:  N/A');
      }

      try {
        const name = await device.getDeviceName();
        console.log(`Name:     ${name}`);
      } catch { /* skip */ }

      try {
        const serial = await device.getSerialNumber();
        console.log(`Serial:   ${serial}`);
      } catch { /* skip */ }

      try {
        const version = await device.getSoftwareVersion();
        console.log(`Software: ${version}`);
      } catch { /* skip */ }

      await device.disconnect();
    },
  })
  .demandCommand()
  .parse();
