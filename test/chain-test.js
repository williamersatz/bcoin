'use strict';

var assert = require('assert');
var BN = require('../lib/crypto/bn');
var consensus = require('../lib/protocol/consensus');
var encoding = require('../lib/utils/encoding');
var co = require('../lib/utils/co');
var Coin = require('../lib/primitives/coin');
var Script = require('../lib/script/script');
var Chain = require('../lib/blockchain/chain');
var Miner = require('../lib/mining/miner');
var MTX = require('../lib/primitives/mtx');
var MemWallet = require('./util/memwallet');
var Network = require('../lib/protocol/network');
var Output = require('../lib/primitives/output');
var util = require('../lib/utils/util');
var common = require('../lib/blockchain/common');
var opcodes = Script.opcodes;

describe('Chain', function() {
  var network = Network.get('regtest');
  var chain = new Chain({ db: 'memory', network: network });
  var miner = new Miner({ chain: chain, version: 4 });
  var wallet = new MemWallet({ network: network });
  var wwallet = new MemWallet({ network: network, witness: true });
  var cpu = miner.cpu;
  var tip1, tip2;

  this.timeout(45000);

  async function addBlock(block, flags) {
    var entry;

    try {
      entry = await chain.add(block, flags);
    } catch (e) {
      assert(e.type === 'VerifyError');
      return e.reason;
    }

    if (!entry)
      return 'bad-prevblk';

    return 'OK';
  }

  async function mineBlock(job, flags) {
    var block = await job.mineAsync();
    return await addBlock(block, flags);
  }

  async function mineCSV(tx) {
    var job = await cpu.createJob();
    var rtx;

    rtx = new MTX();

    rtx.addOutput({
      script: [
        Script.array(new BN(1)),
        Script.opcodes.OP_CHECKSEQUENCEVERIFY
      ],
      value: 10000
    });

    rtx.addTX(tx, 0);

    rtx.setLocktime(chain.height);

    wallet.sign(rtx);

    job.addTX(rtx.toTX(), rtx.view);
    job.refresh();

    return await job.mineAsync();
  }

  chain.on('connect', function(entry, block) {
    wallet.addBlock(entry, block.txs);
  });

  chain.on('disconnect', function(entry, block) {
    wallet.removeBlock(entry, block.txs);
  });

  it('should open chain and miner', async function() {
    await chain.open();
    await miner.open();
  });

  it('should add addrs to miner', async function() {
    miner.addresses.length = 0;
    miner.addAddress(wallet.getReceive());
  });

  it('should mine 200 blocks', async function() {
    var i, block;

    for (i = 0; i < 200; i++) {
      block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }

    assert.equal(chain.height, 200);
  });

  it('should mine competing chains', async function() {
    var i, mtx, job1, job2, blk1, blk2, hash1, hash2;

    for (i = 0; i < 10; i++) {
      job1 = await cpu.createJob(tip1);
      job2 = await cpu.createJob(tip2);

      mtx = await wallet.create({
        outputs: [{
          address: wallet.getAddress(),
          value: 10 * 1e8
        }]
      });

      job1.addTX(mtx.toTX(), mtx.view);
      job2.addTX(mtx.toTX(), mtx.view);

      job1.refresh();
      job2.refresh();

      blk1 = await job1.mineAsync();
      blk2 = await job2.mineAsync();

      hash1 = blk1.hash('hex');
      hash2 = blk2.hash('hex');

      assert(await chain.add(blk1));
      assert(await chain.add(blk2));

      assert(chain.tip.hash === hash1);

      tip1 = await chain.db.getEntry(hash1);
      tip2 = await chain.db.getEntry(hash2);

      assert(tip1);
      assert(tip2);

      assert(!(await tip2.isMainChain()));
    }
  });

  it('should have correct chain value', function() {
    assert.equal(chain.db.state.value, 897500000000);
    assert.equal(chain.db.state.coin, 220);
    assert.equal(chain.db.state.tx, 221);
  });

  it('should have correct wallet balance', async function() {
    assert.equal(wallet.balance, 897500000000);
  });

  it('should handle a reorg', async function() {
    var forked = false;
    var entry, block;

    assert.equal(chain.height, 210);

    entry = await chain.db.getEntry(tip2.hash);
    assert(entry);
    assert(chain.height === entry.height);

    block = await cpu.mineBlock(entry);
    assert(block);

    chain.once('reorganize', function() {
      forked = true;
    });

    assert(await chain.add(block));

    assert(forked);
    assert(chain.tip.hash === block.hash('hex'));
    assert(chain.tip.chainwork.cmp(tip1.chainwork) > 0);
  });

  it('should have correct chain value', function() {
    assert.equal(chain.db.state.value, 900000000000);
    assert.equal(chain.db.state.coin, 221);
    assert.equal(chain.db.state.tx, 222);
  });

  it('should have correct wallet balance', async function() {
    assert.equal(wallet.balance, 900000000000);
  });

  it('should check main chain', async function() {
    var result = await tip1.isMainChain();
    assert(!result);
  });

  it('should mine a block after a reorg', async function() {
    var block = await cpu.mineBlock();
    var hash, entry, result;

    assert(await chain.add(block));

    hash = block.hash('hex');
    entry = await chain.db.getEntry(hash);

    assert(entry);
    assert(chain.tip.hash === entry.hash);

    result = await entry.isMainChain();
    assert(result);
  });

  it('should prevent double spend on new chain', async function() {
    var job = await cpu.createJob();
    var mtx, block;

    mtx = await wallet.create({
      outputs: [{
        address: wallet.getAddress(),
        value: 10 * 1e8
      }]
    });

    job.addTX(mtx.toTX(), mtx.view);
    job.refresh();

    block = await job.mineAsync();

    assert(await chain.add(block));

    job = await cpu.createJob();

    assert(mtx.outputs.length > 1);
    mtx.outputs.pop();

    job.addTX(mtx.toTX(), mtx.view);
    job.refresh();

    assert.equal(await mineBlock(job), 'bad-txns-inputs-missingorspent');
  });

  it('should fail to connect coins on an alternate chain', async function() {
    var block = await chain.db.getBlock(tip1.hash);
    var cb = block.txs[0];
    var mtx = new MTX();
    var job;

    mtx.addTX(cb, 0);
    mtx.addOutput(wallet.getAddress(), 10 * 1e8);

    wallet.sign(mtx);

    job = await cpu.createJob();
    job.addTX(mtx.toTX(), mtx.view);
    job.refresh();

    assert.equal(await mineBlock(job), 'bad-txns-inputs-missingorspent');
  });

  it('should have correct chain value', function() {
    assert.equal(chain.db.state.value, 905000000000);
    assert.equal(chain.db.state.coin, 224);
    assert.equal(chain.db.state.tx, 225);
  });

  it('should get coin', async function() {
    var mtx, job, block, tx, output, coin;

    mtx = await wallet.send({
      outputs: [
        {
          address: wallet.getAddress(),
          value: 1e8
        },
        {
          address: wallet.getAddress(),
          value: 1e8
        },
        {
          address: wallet.getAddress(),
          value: 1e8
        }
      ]
    });

    job = await cpu.createJob();
    job.addTX(mtx.toTX(), mtx.view);
    job.refresh();

    block = await job.mineAsync();
    assert(await chain.add(block));

    tx = block.txs[1];
    output = Coin.fromTX(tx, 2, chain.height);

    coin = await chain.db.getCoin(tx.hash('hex'), 2);

    assert.deepEqual(coin.toRaw(), output.toRaw());
  });

  it('should have correct wallet balance', async function() {
    assert.equal(wallet.balance, 907500000000);
    assert.equal(wallet.receiveDepth, 15);
    assert.equal(wallet.changeDepth, 14);
    assert.equal(wallet.txs, 226);
  });

  it('should get tips and remove chains', async function() {
    var tips = await chain.db.getTips();

    assert.notEqual(tips.indexOf(chain.tip.hash), -1);
    assert.equal(tips.length, 2);

    await chain.db.removeChains();

    tips = await chain.db.getTips();

    assert.notEqual(tips.indexOf(chain.tip.hash), -1);
    assert.equal(tips.length, 1);
  });

  it('should rescan for transactions', async function() {
    var total = 0;

    await chain.db.scan(0, wallet.filter, function(block, txs) {
      total += txs.length;
      return Promise.resolve();
    });

    assert.equal(total, 226);
  });

  it('should activate csv', async function() {
    var deployments = network.deployments;
    var i, block, prev, state, cache;

    miner.options.version = -1;

    assert.equal(chain.height, 214);

    prev = await chain.tip.getPrevious();
    state = await chain.getState(prev, deployments.csv);
    assert.equal(state, 1);

    for (i = 0; i < 417; i++) {
      block = await cpu.mineBlock();
      assert(await chain.add(block));
      switch (chain.height) {
        case 288:
          prev = await chain.tip.getPrevious();
          state = await chain.getState(prev, deployments.csv);
          assert.equal(state, 1);
          break;
        case 432:
          prev = await chain.tip.getPrevious();
          state = await chain.getState(prev, deployments.csv);
          assert.equal(state, 2);
          break;
        case 576:
          prev = await chain.tip.getPrevious();
          state = await chain.getState(prev, deployments.csv);
          assert.equal(state, 3);
          break;
      }
    }

    assert.equal(chain.height, 631);
    assert(chain.state.hasCSV());
    assert(chain.state.hasWitness());

    cache = await chain.db.getStateCache();
    assert.deepEqual(cache, chain.db.stateCache);
    assert.equal(chain.db.stateCache.updates.length, 0);
    assert(await chain.db.verifyDeployments());
  });

  it('should have activated segwit', async function() {
    var deployments = network.deployments;
    var prev = await chain.tip.getPrevious();
    var state = await chain.getState(prev, deployments.segwit);
    assert.equal(state, 3);
  });

  it('should test csv', async function() {
    var tx = (await chain.db.getBlock(chain.height - 100)).txs[0];
    var block = await mineCSV(tx);
    var csv, job, rtx;

    assert(await chain.add(block));

    csv = block.txs[1];

    rtx = new MTX();

    rtx.addOutput({
      script: [
        Script.array(new BN(2)),
        Script.opcodes.OP_CHECKSEQUENCEVERIFY
      ],
      value: 10000
    });

    rtx.addTX(csv, 0);
    rtx.setSequence(0, 1, false);

    job = await cpu.createJob();

    job.addTX(rtx.toTX(), rtx.view);
    job.refresh();

    block = await job.mineAsync();

    assert(await chain.add(block));
  });

  it('should fail csv with bad sequence', async function() {
    var csv = (await chain.db.getBlock(chain.height - 100)).txs[0];
    var rtx = new MTX();
    var job;

    rtx.addOutput({
      script: [
        Script.array(new BN(1)),
        Script.opcodes.OP_CHECKSEQUENCEVERIFY
      ],
      value: 1 * 1e8
    });

    rtx.addTX(csv, 0);
    rtx.setSequence(0, 1, false);

    job = await cpu.createJob();
    job.addTX(rtx.toTX(), rtx.view);
    job.refresh();

    assert.equal(await mineBlock(job), 'mandatory-script-verify-flag-failed');
  });

  it('should mine a block', async function() {
    var block = await cpu.mineBlock();
    assert(block);
    assert(await chain.add(block));
  });

  it('should fail csv lock checks', async function() {
    var tx = (await chain.db.getBlock(chain.height - 100)).txs[0];
    var block = await mineCSV(tx);
    var csv, job, rtx;

    assert(await chain.add(block));

    csv = block.txs[1];

    rtx = new MTX();

    rtx.addOutput({
      script: [
        Script.array(new BN(2)),
        Script.opcodes.OP_CHECKSEQUENCEVERIFY
      ],
      value: 1 * 1e8
    });

    rtx.addTX(csv, 0);
    rtx.setSequence(0, 2, false);

    job = await cpu.createJob();
    job.addTX(rtx.toTX(), rtx.view);
    job.refresh();

    assert.equal(await mineBlock(job), 'bad-txns-nonfinal');
  });

  it('should have correct wallet balance', async function() {
    assert.equal(wallet.balance, 1412499980000);
  });

  it('should fail to connect bad bits', async function() {
    var job = await cpu.createJob();
    job.attempt.bits = 553713663;
    assert.equal(await mineBlock(job), 'bad-diffbits');
  });

  it('should fail to connect bad MTP', async function() {
    var mtp = await chain.tip.getMedianTime();
    var job = await cpu.createJob();
    job.attempt.ts = mtp - 1;
    assert.equal(await mineBlock(job), 'time-too-old');
  });

  it('should fail to connect bad time', async function() {
    var job = await cpu.createJob();
    var now = network.now() + 3 * 60 * 60;
    job.attempt.ts = now;
    assert.equal(await mineBlock(job), 'time-too-new');
  });

  it('should fail to connect bad locktime', async function() {
    var job = await cpu.createJob();
    var tx = await wallet.send({ locktime: 100000 });
    job.pushTX(tx.toTX());
    job.refresh();
    assert.equal(await mineBlock(job), 'bad-txns-nonfinal');
  });

  it('should fail to connect bad cb height', async function() {
    var bip34height = network.block.bip34height;
    var job = await cpu.createJob();

    job.attempt.height = 10;
    job.attempt.refresh();

    try {
      network.block.bip34height = 0;
      assert.equal(await mineBlock(job), 'bad-cb-height');
    } finally {
      network.block.bip34height = bip34height;
    }
  });

  it('should fail to connect bad witness nonce size', async function() {
    var block = await cpu.mineBlock();
    var tx = block.txs[0];
    var input = tx.inputs[0];
    input.witness.set(0, Buffer.allocUnsafe(33));
    input.witness.compile();
    block.refresh(true);
    assert.equal(await addBlock(block), 'bad-witness-nonce-size');
  });

  it('should fail to connect bad witness nonce', async function() {
    var block = await cpu.mineBlock();
    var tx = block.txs[0];
    var input = tx.inputs[0];
    input.witness.set(0, encoding.ONE_HASH);
    input.witness.compile();
    block.refresh(true);
    assert.equal(await addBlock(block), 'bad-witness-merkle-match');
  });

  it('should fail to connect bad witness commitment', async function() {
    var flags = common.flags.DEFAULT_FLAGS & ~common.flags.VERIFY_POW;
    var block = await cpu.mineBlock();
    var tx = block.txs[0];
    var output = tx.outputs[1];
    var commit;

    assert(output.script.isCommitment());

    commit = util.copy(output.script.get(1));
    commit.fill(0, 10);
    output.script.set(1, commit);
    output.script.compile();

    block.refresh(true);
    block.merkleRoot = block.createMerkleRoot('hex');

    assert.equal(await addBlock(block, flags), 'bad-witness-merkle-match');
  });

  it('should fail to connect unexpected witness', async function() {
    var flags = common.flags.DEFAULT_FLAGS & ~common.flags.VERIFY_POW;
    var block = await cpu.mineBlock();
    var tx = block.txs[0];
    var output = tx.outputs[1];

    assert(output.script.isCommitment());

    tx.outputs.pop();

    block.refresh(true);
    block.merkleRoot = block.createMerkleRoot('hex');

    assert.equal(await addBlock(block, flags), 'unexpected-witness');
  });

  it('should add wit addrs to miner', async function() {
    miner.addresses.length = 0;
    miner.addAddress(wwallet.getReceive());
    assert.equal(wwallet.getReceive().getType(), 'witness');
  });

  it('should mine 2000 witness blocks', async function() {
    var i, block;

    for (i = 0; i < 2001; i++) {
      block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }

    assert.equal(chain.height, 2636);
  });

  it('should mine a witness tx', async function() {
    var block = await chain.db.getBlock(chain.height - 2000);
    var cb = block.txs[0];
    var mtx = new MTX();
    var job;

    mtx.addTX(cb, 0);
    mtx.addOutput(wwallet.getAddress(), 1000);

    wwallet.sign(mtx);

    job = await cpu.createJob();
    job.addTX(mtx.toTX(), mtx.view);
    job.refresh();

    block = await job.mineAsync();

    assert(await chain.add(block));
  });

  it('should mine fail to connect too much weight', async function() {
    var start = chain.height - 2000;
    var end = chain.height - 200;
    var job = await cpu.createJob();
    var mtx = new MTX();
    var i, j, block, cb;

    for (i = start; i <= end; i++) {
      block = await chain.db.getBlock(i);
      cb = block.txs[0];

      mtx = new MTX();
      mtx.addTX(cb, 0);

      for (j = 0; j < 16; j++)
        mtx.addOutput(wwallet.getAddress(), 1);

      wwallet.sign(mtx);

      job.pushTX(mtx.toTX());
    }

    job.refresh();

    assert.equal(await mineBlock(job), 'bad-blk-weight');
  });

  it('should mine fail to connect too much size', async function() {
    var start = chain.height - 2000;
    var end = chain.height - 200;
    var job = await cpu.createJob();
    var mtx = new MTX();
    var i, j, block, cb;

    for (i = start; i <= end; i++) {
      block = await chain.db.getBlock(i);
      cb = block.txs[0];

      mtx = new MTX();
      mtx.addTX(cb, 0);

      for (j = 0; j < 20; j++)
        mtx.addOutput(wwallet.getAddress(), 1);

      wwallet.sign(mtx);

      job.pushTX(mtx.toTX());
    }

    job.refresh();

    assert.equal(await mineBlock(job), 'bad-blk-length');
  });

  it('should mine a big block', async function() {
    var start = chain.height - 2000;
    var end = chain.height - 200;
    var job = await cpu.createJob();
    var mtx = new MTX();
    var i, j, block, cb;

    for (i = start; i <= end; i++) {
      block = await chain.db.getBlock(i);
      cb = block.txs[0];

      mtx = new MTX();
      mtx.addTX(cb, 0);

      for (j = 0; j < 15; j++)
        mtx.addOutput(wwallet.getAddress(), 1);

      wwallet.sign(mtx);

      job.pushTX(mtx.toTX());
    }

    job.refresh();

    assert.equal(await mineBlock(job), 'OK');
  });

  it('should fail to connect bad versions', async function() {
    var i, job;

    for (i = 0; i <= 3; i++) {
      job = await cpu.createJob();
      job.attempt.version = i;
      assert.equal(await mineBlock(job), 'bad-version');
    }
  });

  it('should fail to connect bad amount', async function() {
    var job = await cpu.createJob();

    job.attempt.fees += 1;
    job.refresh();
    assert.equal(await mineBlock(job), 'bad-cb-amount');
  });

  it('should fail to connect premature cb spend', async function() {
    var job = await cpu.createJob();
    var block = await chain.db.getBlock(chain.height - 98);
    var cb = block.txs[0];
    var mtx = new MTX();

    mtx.addTX(cb, 0);
    mtx.addOutput(wwallet.getAddress(), 1);

    wwallet.sign(mtx);

    job.addTX(mtx.toTX(), mtx.view);
    job.refresh();

    assert.equal(await mineBlock(job),
      'bad-txns-premature-spend-of-coinbase');
  });

  it('should fail to connect vout belowout', async function() {
    var job = await cpu.createJob();
    var block = await chain.db.getBlock(chain.height - 99);
    var cb = block.txs[0];
    var mtx = new MTX();

    mtx.addTX(cb, 0);
    mtx.addOutput(wwallet.getAddress(), 1e8);

    wwallet.sign(mtx);

    job.pushTX(mtx.toTX());
    job.refresh();

    assert.equal(await mineBlock(job),
      'bad-txns-in-belowout');
  });

  it('should fail to connect outtotal toolarge', async function() {
    var job = await cpu.createJob();
    var block = await chain.db.getBlock(chain.height - 99);
    var cb = block.txs[0];
    var mtx = new MTX();

    mtx.addTX(cb, 0);
    mtx.addOutput(wwallet.getAddress(), Math.floor(consensus.MAX_MONEY / 2));
    mtx.addOutput(wwallet.getAddress(), Math.floor(consensus.MAX_MONEY / 2));
    mtx.addOutput(wwallet.getAddress(), Math.floor(consensus.MAX_MONEY / 2));

    wwallet.sign(mtx);

    job.pushTX(mtx.toTX());
    job.refresh();

    assert.equal(await mineBlock(job),
      'bad-txns-txouttotal-toolarge');
  });

  it('should mine 111 multisig blocks', async function() {
    var flags = common.flags.DEFAULT_FLAGS & ~common.flags.VERIFY_POW;
    var i, j, script, job, cb, output, val, block;

    script = new Script();
    script.push(new BN(20));

    for (i = 0; i < 20; i++)
      script.push(encoding.ZERO_KEY);

    script.push(new BN(20));
    script.push(opcodes.OP_CHECKMULTISIG);
    script.compile();

    script = Script.fromScripthash(script.hash160());

    for (i = 0; i < 111; i++) {
      block = await cpu.mineBlock();
      cb = block.txs[0];
      val = cb.outputs[0].value;

      cb.outputs[0].value = 0;

      for (j = 0; j < Math.min(100, val); j++) {
        output = new Output();
        output.script = script.clone();
        output.value = 1;

        cb.outputs.push(output);
      }

      block.refresh(true);
      block.merkleRoot = block.createMerkleRoot('hex');

      assert(await chain.add(block, flags));
    }

    assert.equal(chain.height, 2749);
  });

  it('should fail to connect too many sigops', async function() {
    var start = chain.height - 110;
    var end = chain.height - 100;
    var job = await cpu.createJob();
    var i, j, mtx, script, block, cb;

    script = new Script();
    script.push(new BN(20));

    for (i = 0; i < 20; i++)
      script.push(encoding.ZERO_KEY);

    script.push(new BN(20));
    script.push(opcodes.OP_CHECKMULTISIG);
    script.compile();

    for (i = start; i <= end; i++) {
      block = await chain.db.getBlock(i);
      cb = block.txs[0];

      if (cb.outputs.length === 2)
        continue;

      mtx = new MTX();

      for (j = 2; j < cb.outputs.length; j++) {
        mtx.addTX(cb, j);
        mtx.inputs[j - 2].script = new Script([script.toRaw()]);
      }

      mtx.addOutput(wwallet.getAddress(), 1);

      job.pushTX(mtx.toTX());
    }

    job.refresh();

    assert.equal(await mineBlock(job), 'bad-blk-sigops');
  });

  it('should cleanup', async function() {
    await miner.close();
    await chain.close();
  });
});
