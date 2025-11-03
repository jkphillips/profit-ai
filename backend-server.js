// backend-server.js - Profit AI (Aster Dex Edition)
// Automated trading bot for SUIUSDT on Aster Dex Perpetual Futures

// Load environment variables (optional for Railway)
try {
    require('dotenv').config();
} catch (err) {
    console.log('INFO:  Using Railway environment variables');
}
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// ASTER DEX CONFIG
// ============================================
const CONFIG = {
    API_KEY: process.env.API_KEY,
    API_SECRET: process.env.API_SECRET,
    BASE_URL: 'https://fapi.asterdex.com',
    SYMBOL: 'SUIUSDT',
    TIMEFRAME: '5m',
    POSITION_SIZE: parseFloat(process.env.POSITION_SIZE) || 100,
    LEVERAGE: parseInt(process.env.LEVERAGE) || 10,
    MA_PERIOD: 100,
    ATR_PERIOD: 10,
    ATR_MULTIPLIER: 3,
    RISK_REWARD_RATIO: 1,
    PORT: process.env.PORT || 3000,
    CHECK_INTERVAL: 30000,
};

let tradingState = {
    balance: 0,
    inPosition: false,
    currentPosition: null,
    trades: [],
    priceData: [],
    lastUpdate: null
};

// ============================================
// ASTER DEX API
// ============================================
class AsterDexAPI {
    constructor() {
        this.baseURL = CONFIG.BASE_URL;
    }

    generateSignature(queryString) {
        return crypto.createHmac('sha256', CONFIG.API_SECRET).update(queryString).digest('hex');
    }

    async getServerTime() {
        try {
            const response = await axios.get(`${this.baseURL}/fapi/v1/time`);
            return response.data.serverTime;
        } catch (error) {
            return Date.now();
        }
    }

    async getBalance() {
        try {
            const timestamp = await this.getServerTime();
            const queryString = `timestamp=${timestamp}`;
            const signature = this.generateSignature(queryString);
            
            const response = await axios.get(`${this.baseURL}/fapi/v2/balance`, {
                params: { timestamp, signature },
                headers: { 'X-MBX-APIKEY': CONFIG.API_KEY }
            });

            const usdtBalance = response.data.find(b => b.asset === 'USDT');
            return parseFloat(usdtBalance?.availableBalance || 0);
        } catch (error) {
            console.error('Error fetching balance:', error.response?.data || error.message);
            return 0;
        }
    }

    async getCurrentPrice(symbol) {
        try {
            const response = await axios.get(`${this.baseURL}/fapi/v1/ticker/price`, {
                params: { symbol }
            });
            return parseFloat(response.data.price);
        } catch (error) {
            console.error('Error fetching price:', error.message);
            return null;
        }
    }

    async getKlines(symbol, interval, limit = 150) {
        try {
            const response = await axios.get(`${this.baseURL}/fapi/v1/klines`, {
                params: { symbol, interval, limit }
            });
            
            return response.data.map(candle => ({
                timestamp: candle[0],
                open: parseFloat(candle[1]),
                high: parseFloat(candle[2]),
                low: parseFloat(candle[3]),
                close: parseFloat(candle[4]),
                volume: parseFloat(candle[5])
            }));
        } catch (error) {
            console.error('Error fetching klines:', error.message);
            return [];
        }
    }

    async setLeverage(symbol, leverage) {
        try {
            const timestamp = await this.getServerTime();
            const queryString = `symbol=${symbol}&leverage=${leverage}&timestamp=${timestamp}`;
            const signature = this.generateSignature(queryString);
            
            const response = await axios.post(`${this.baseURL}/fapi/v1/leverage`, null, {
                params: { symbol, leverage, timestamp, signature },
                headers: { 'X-MBX-APIKEY': CONFIG.API_KEY }
            });
            
            console.log(`🔢 Leverage set to ${leverage}x`);
            return response.data;
        } catch (error) {
            console.error('Error setting leverage:', error.response?.data || error.message);
            return null;
        }
    }

    async placeMarketOrder(symbol, side, quantity) {
        try {
            const timestamp = await this.getServerTime();
            const queryString = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${timestamp}`;
            const signature = this.generateSignature(queryString);
            
            const response = await axios.post(`${this.baseURL}/fapi/v1/order`, null, {
                params: { symbol, side, type: 'MARKET', quantity, timestamp, signature },
                headers: { 'X-MBX-APIKEY': CONFIG.API_KEY }
            });
            
            console.log(`✅ Order placed: ${side} ${quantity} ${symbol}`);
            return response.data;
        } catch (error) {
            console.error('Error placing order:', error.response?.data || error.message);
            return null;
        }
    }

    async placeStopOrder(symbol, side, quantity, stopPrice) {
        try {
            const timestamp = await this.getServerTime();
            const queryString = `symbol=${symbol}&side=${side}&type=STOP_MARKET&stopPrice=${stopPrice}&quantity=${quantity}&timestamp=${timestamp}`;
            const signature = this.generateSignature(queryString);
            
            const response = await axios.post(`${this.baseURL}/fapi/v1/order`, null, {
                params: { symbol, side, type: 'STOP_MARKET', stopPrice, quantity, timestamp, signature },
                headers: { 'X-MBX-APIKEY': CONFIG.API_KEY }
            });
            
            console.log(`🛡️ Stop loss set at $${stopPrice}`);
            return response.data;
        } catch (error) {
            console.error('Error placing stop:', error.response?.data || error.message);
            return null;
        }
    }

    async getPosition(symbol) {
        try {
            const timestamp = await this.getServerTime();
            const queryString = `timestamp=${timestamp}`;
            const signature = this.generateSignature(queryString);
            
            const response = await axios.get(`${this.baseURL}/fapi/v2/positionRisk`, {
                params: { timestamp, signature },
                headers: { 'X-MBX-APIKEY': CONFIG.API_KEY }
            });

            return response.data.find(p => p.symbol === symbol);
        } catch (error) {
            console.error('Error fetching position:', error.response?.data || error.message);
            return null;
        }
    }

    async closePosition(symbol) {
        try {
            const position = await this.getPosition(symbol);
            if (!position || parseFloat(position.positionAmt) === 0) {
                console.log('No position to close');
                return null;
            }

            const positionAmt = Math.abs(parseFloat(position.positionAmt));
            const side = parseFloat(position.positionAmt) > 0 ? 'SELL' : 'BUY';

            return await this.placeMarketOrder(symbol, side, positionAmt);
        } catch (error) {
            console.error('Error closing position:', error.message);
            return null;
        }
    }
}

// ============================================
// INDICATORS (SECRET STRATEGY)
// ============================================
class Indicators {
    static calculateSMA(data, period) {
        if (data.length < period) return null;
        const slice = data.slice(-period);
        return slice.reduce((acc, c) => acc + c.close, 0) / period;
    }

    static calculateATR(data, period = 14) {
        if (data.length < period + 1) return null;
        let trueRanges = [];
        for (let i = 1; i < data.length; i++) {
            const tr = Math.max(
                data[i].high - data[i].low,
                Math.abs(data[i].high - data[i - 1].close),
                Math.abs(data[i].low - data[i - 1].close)
            );
            trueRanges.push(tr);
        }
        const recentTR = trueRanges.slice(-period);
        return recentTR.reduce((a, b) => a + b, 0) / period;
    }

    static calculateATRTrailingStop(data, atrPeriod = 10, atrMultiplier = 3) {
        if (data.length < atrPeriod + 1) return null;
        const atr = this.calculateATR(data, atrPeriod);
        const currentPrice = data[data.length - 1].close;
        return { value: currentPrice - (atr * atrMultiplier), atr: atr };
    }

    static detectSmartMoneySignal(data) {
        if (data.length < 20) return null;
        const current = data[data.length - 1];
        const previous = data[data.length - 2];
        const avgVolume = data.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20;
        const volumeSpike = current.volume > avgVolume * 1.5;
        const momentum = Math.abs(current.close - previous.close) / previous.close;
        const strongMomentum = momentum > 0.002;
        
        if (volumeSpike && current.close > previous.close && strongMomentum) return 'BUY';
        if (volumeSpike && current.close < previous.close && strongMomentum) return 'SELL';
        return null;
    }

    static checkEntrySignal(data) {
        if (data.length < 100) return null;
        const ma100 = this.calculateSMA(data, CONFIG.MA_PERIOD);
        const atrStop = this.calculateATRTrailingStop(data, CONFIG.ATR_PERIOD, CONFIG.ATR_MULTIPLIER);
        const smartMoneySignal = this.detectSmartMoneySignal(data);
        
        if (!ma100 || !atrStop) return null;
        const currentPrice = data[data.length - 1].close;
        
        if (atrStop.value > ma100 && smartMoneySignal === 'BUY') {
            const risk = currentPrice - ma100;
            return {
                type: 'LONG',
                entryPrice: currentPrice,
                stopLoss: ma100,
                takeProfit: currentPrice + (risk * CONFIG.RISK_REWARD_RATIO),
                ma100, atrStop: atrStop.value
            };
        }
        
        if (atrStop.value < ma100 && smartMoneySignal === 'SELL') {
            const risk = ma100 - currentPrice;
            return {
                type: 'SHORT',
                entryPrice: currentPrice,
                stopLoss: ma100,
                takeProfit: currentPrice - (risk * CONFIG.RISK_REWARD_RATIO),
                ma100, atrStop: atrStop.value
            };
        }
        return null;
    }

    static checkExit(position, currentPrice) {
        if (position.type === 'LONG') {
            if (currentPrice <= position.stopLoss) return { exit: true, reason: 'STOP_LOSS', price: currentPrice };
            if (currentPrice >= position.takeProfit) return { exit: true, reason: 'TAKE_PROFIT', price: currentPrice };
        } else {
            if (currentPrice >= position.stopLoss) return { exit: true, reason: 'STOP_LOSS', price: currentPrice };
            if (currentPrice <= position.takeProfit) return { exit: true, reason: 'TAKE_PROFIT', price: currentPrice };
        }
        return { exit: false };
    }
}

// ============================================
// TRADING ENGINE
// ============================================
class TradingEngine {
    constructor() {
        this.api = new AsterDexAPI();
        this.isRunning = false;
    }

    async initialize() {
        console.log('🚀 Profit AI - Aster Dex Edition');
        console.log(`💰 Symbol: ${CONFIG.SYMBOL}`);
        console.log(`🔢 Leverage: ${CONFIG.LEVERAGE}x`);
        
        await this.api.setLeverage(CONFIG.SYMBOL, CONFIG.LEVERAGE);
        tradingState.balance = await this.api.getBalance();
        console.log(`💵 Balance: $${tradingState.balance.toFixed(2)} USDT`);
        
        await this.updatePriceData();
        console.log('✅ Initialized!\n');
    }

    async updatePriceData() {
        const klines = await this.api.getKlines(CONFIG.SYMBOL, CONFIG.TIMEFRAME, 150);
        if (klines.length > 0) {
            tradingState.priceData = klines;
            tradingState.lastUpdate = new Date();
        }
    }

    async checkForSignals() {
        await this.updatePriceData();
        const currentPrice = tradingState.priceData[tradingState.priceData.length - 1]?.close;
        if (!currentPrice) return;
        
        if (tradingState.inPosition && tradingState.currentPosition) {
            const exitCheck = Indicators.checkExit(tradingState.currentPosition, currentPrice);
            if (exitCheck.exit) {
                await this.closePosition(exitCheck.reason, exitCheck.price);
            } else {
                const unrealizedPnL = tradingState.currentPosition.type === 'LONG'
                    ? (currentPrice - tradingState.currentPosition.entryPrice) * tradingState.currentPosition.quantity
                    : (tradingState.currentPosition.entryPrice - currentPrice) * tradingState.currentPosition.quantity;
                console.log(`📊 In ${tradingState.currentPosition.type} | Price: $${currentPrice.toFixed(4)} | P&L: ${unrealizedPnL >= 0 ? '+' : ''}$${unrealizedPnL.toFixed(2)}`);
            }
            return;
        }
        
        const signal = Indicators.checkEntrySignal(tradingState.priceData);
        if (signal) {
            console.log(`\n🎯 SIGNAL: ${signal.type} @ $${signal.entryPrice.toFixed(4)}`);
            await this.openPosition(signal);
        } else {
            console.log(`⏳ ${new Date().toLocaleTimeString()} | ${CONFIG.SYMBOL}: $${currentPrice.toFixed(4)}`);
        }
    }

    async openPosition(signal) {
        try {
            const balance = await this.api.getBalance();
            const positionValue = (balance * CONFIG.POSITION_SIZE / 100) * CONFIG.LEVERAGE;
            const quantity = Math.floor((positionValue / signal.entryPrice) * 10) / 10;
            
            if (quantity <= 0) {
                console.log('❌ Quantity too small');
                return;
            }
            
            const side = signal.type === 'LONG' ? 'BUY' : 'SELL';
            const order = await this.api.placeMarketOrder(CONFIG.SYMBOL, side, quantity);
            
            if (order) {
                tradingState.inPosition = true;
                tradingState.currentPosition = {
                    ...signal, quantity,
                    timestamp: new Date().toISOString(),
                    orderId: order.orderId
                };
                
                console.log(`✅ ${signal.type} opened: ${quantity} SUI`);
                const stopSide = signal.type === 'LONG' ? 'SELL' : 'BUY';
                await this.api.placeStopOrder(CONFIG.SYMBOL, stopSide, quantity, signal.stopLoss.toFixed(4));
            }
        } catch (error) {
            console.error('❌ Error opening:', error.message);
        }
    }

    async closePosition(reason, exitPrice) {
        try {
            const position = tradingState.currentPosition;
            const order = await this.api.closePosition(CONFIG.SYMBOL);
            
            if (order) {
                let profit = position.type === 'LONG'
                    ? (exitPrice - position.entryPrice) * position.quantity
                    : (position.entryPrice - exitPrice) * position.quantity;
                
                profit = profit * CONFIG.LEVERAGE;
                
                const trade = {
                    type: position.type,
                    entryPrice: position.entryPrice,
                    exitPrice,
                    quantity: position.quantity,
                    profit,
                    reason,
                    timestamp: new Date().toISOString()
                };
                
                tradingState.trades.push(trade);
                tradingState.balance += profit;
                
                console.log(`\n🏁 ${position.type} closed | ${reason}`);
                console.log(`   $${position.entryPrice.toFixed(4)} → $${exitPrice.toFixed(4)}`);
                console.log(`   Profit: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`);
                console.log(`   Balance: $${tradingState.balance.toFixed(2)}\n`);
                
                tradingState.inPosition = false;
                tradingState.currentPosition = null;
            }
        } catch (error) {
            console.error('❌ Error closing:', error.message);
        }
    }

    async start() {
        this.isRunning = true;
        console.log('🤖 Bot started!\n');
        while (this.isRunning) {
            try {
                await this.checkForSignals();
            } catch (error) {
                console.error('❌ Error:', error.message);
            }
            await new Promise(resolve => setTimeout(resolve, CONFIG.CHECK_INTERVAL));
        }
    }

    stop() {
        this.isRunning = false;
        console.log('🛑 Bot stopped');
    }
}

// ============================================
// API ENDPOINTS
// ============================================
app.get('/api/status', async (req, res) => {
    const api = new AsterDexAPI();
    const balance = await api.getBalance();
    res.json({
        balance,
        inPosition: tradingState.inPosition,
        currentPosition: tradingState.currentPosition,
        totalTrades: tradingState.trades.length,
        lastUpdate: tradingState.lastUpdate
    });
});

app.get('/api/trades', (req, res) => {
    const winningTrades = tradingState.trades.filter(t => t.profit > 0).length;
    const totalProfit = tradingState.trades.reduce((sum, t) => sum + t.profit, 0);
    res.json({
        trades: tradingState.trades,
        totalTrades: tradingState.trades.length,
        winningTrades,
        winRate: tradingState.trades.length > 0 ? (winningTrades / tradingState.trades.length * 100).toFixed(1) : 0,
        totalProfit
    });
});

app.get('/api/market', async (req, res) => {
    const api = new AsterDexAPI();
    const price = await api.getCurrentPrice(CONFIG.SYMBOL);
    res.json({ symbol: CONFIG.SYMBOL, price, timestamp: new Date().toISOString() });
});

app.post('/api/stop', (req, res) => {
    if (tradingEngine) tradingEngine.stop();
    res.json({ message: 'Trading stopped' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), exchange: 'Aster Dex', symbol: CONFIG.SYMBOL });
});

// ============================================
// START
// ============================================
let tradingEngine;

async function startServer() {
    if (!CONFIG.API_KEY || !CONFIG.API_SECRET) {
        console.error('❌ ERROR: Set API_KEY and API_SECRET in .env file!');
        process.exit(1);
    }
    
    app.listen(CONFIG.PORT, () => {
        console.log(`🌐 Server running on port ${CONFIG.PORT}`);
        console.log(`📡 Aster Dex (${CONFIG.BASE_URL})\n`);
    });
    
    tradingEngine = new TradingEngine();
    await tradingEngine.initialize();
    tradingEngine.start();
}

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    if (tradingEngine) tradingEngine.stop();
    process.exit(0);
});

startServer().catch(error => {
    console.error('❌ Fatal:', error);
    process.exit(1);
});

module.exports = { tradingEngine, tradingState };
