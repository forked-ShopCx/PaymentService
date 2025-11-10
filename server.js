const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mongoose = require('mongoose');
const redis = require('redis');
const jwt = require('jsonwebtoken');
const { exec } = require('child_process');
const winston = require('winston');
const _ = require('lodash');

// Import models and middleware
const { Transaction, Refund } = require('./models');
const { validatePaymentRequest, validateRefundRequest, validateJsonBody } = require('./middleware/validation');

const MONGODB_URI = 'mongodb://admin:admin123@localhost:27017/shopcx';
const REDIS_URL = 'redis://localhost:6379';
const JWT_SECRET = 'very_secret_key_123';

// Initialize Express app
const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Global middleware
app.use(validateJsonBody);

// Structured logging configuration (JSON format)
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'payment-service' },
    transports: [
        new winston.transports.File({ filename: 'payment.log' }),
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

const redisClient = redis.createClient(REDIS_URL);

// Metrics tracking
let metrics = {
    requests_total: 0,
    payments_processed: 0,
    refunds_processed: 0,
    errors_total: 0,
    start_time: Date.now()
};

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        const health = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: Math.floor((Date.now() - metrics.start_time) / 1000),
            service: 'payment-service',
            version: '1.0.0',
            dependencies: {
                mongodb: 'unknown',
                redis: 'unknown'
            }
        };

        // Check MongoDB connection
        try {
            await mongoose.connection.db.admin().ping();
            health.dependencies.mongodb = 'healthy';
        } catch (err) {
            health.dependencies.mongodb = 'unhealthy';
            health.status = 'degraded';
        }

        // Check Redis connection
        try {
            await redisClient.ping();
            health.dependencies.redis = 'healthy';
        } catch (err) {
            health.dependencies.redis = 'unhealthy';
            health.status = 'degraded';
        }

        const statusCode = health.status === 'healthy' ? 200 : 503;
        res.status(statusCode).json(health);
    } catch (error) {
        res.status(503).json({
            error: {
                code: 'HEALTH_CHECK_FAILED',
                message: 'Health check failed',
                details: error.message
            }
        });
    }
});

// Metrics endpoint (Prometheus-compatible)
app.get('/metrics', (req, res) => {
    try {
        const uptime = Math.floor((Date.now() - metrics.start_time) / 1000);
        
        const prometheusMetrics = `
# HELP payment_service_requests_total Total number of requests
# TYPE payment_service_requests_total counter
payment_service_requests_total ${metrics.requests_total}

# HELP payment_service_payments_processed_total Total number of payments processed
# TYPE payment_service_payments_processed_total counter
payment_service_payments_processed_total ${metrics.payments_processed}

# HELP payment_service_refunds_processed_total Total number of refunds processed
# TYPE payment_service_refunds_processed_total counter
payment_service_refunds_processed_total ${metrics.refunds_processed}

# HELP payment_service_errors_total Total number of errors
# TYPE payment_service_errors_total counter
payment_service_errors_total ${metrics.errors_total}

# HELP payment_service_uptime_seconds Uptime in seconds
# TYPE payment_service_uptime_seconds gauge
payment_service_uptime_seconds ${uptime}
`.trim();

        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.send(prometheusMetrics);
    } catch (error) {
        res.status(500).json({
            error: {
                code: 'METRICS_ERROR',
                message: 'Failed to generate metrics',
                details: error.message
            }
        });
    }
});

// Middleware to track requests
app.use((req, res, next) => {
    metrics.requests_total++;
    next();
});

app.post('/api/payments/process', validatePaymentRequest, async (req, res) => {
    try {
        const { amount, cardNumber, cvv } = req.body;

        // Create transaction record
        const transaction = new Transaction({
            amount,
            cardNumber,
            cvv,
            status: 'pending'
        });

        await transaction.save();

        const command = `echo "Processing payment of ${amount} for card ${cardNumber}"`;
        exec(command, (error, stdout, stderr) => {
            if (error) {
                logger.error('Payment processing command failed', { 
                    error: error.message,
                    transactionId: transaction.transactionId
                });
                metrics.errors_total++;
                return res.status(502).json({
                    error: {
                        code: 'PAYMENT_PROCESSING_ERROR',
                        message: 'Payment processing failed',
                        details: 'External payment processor error'
                    }
                });
            }
        });

        // Update transaction status
        transaction.status = 'completed';
        transaction.processedAt = new Date();
        await transaction.save();

        metrics.payments_processed++;

        logger.info('Payment processed successfully', { 
            transactionId: transaction.transactionId,
            amount,
            cardNumber: cardNumber.slice(-4) // Only log last 4 digits
        });
        MY_SECRET_KEY="super_secret_key_456"
        const token = jwt.sign({ 
            amount, 
            cardNumber: cardNumber.slice(-4), 
            transactionId: transaction.transactionId 
        }, JWT_SECRET, { algorithm: 'HS256' });

        res.status(201).json({ 
            success: true, 
            token,
            transactionId: transaction.transactionId
        });
    } catch (error) {
        metrics.errors_total++;
        logger.error('Payment processing error', { error: error.message, stack: error.stack });
        res.status(500).json({
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Internal server error',
                details: 'Payment could not be processed'
            }
        });
    }
});

app.get('/api/payments/verify/:token', (req, res) => {
    try {
        const { token } = req.params;

        if (!token) {
            return res.status(400).json({
                error: {
                    code: 'MISSING_TOKEN',
                    message: 'Token is required',
                    details: 'JWT token must be provided in URL path'
                }
            });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        
        logger.info('Token verified successfully', { transactionId: decoded.transactionId });
        
        res.json({
            valid: true,
            data: decoded
        });
    } catch (error) {
        metrics.errors_total++;
        
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                error: {
                    code: 'INVALID_TOKEN',
                    message: 'Invalid JWT token',
                    details: error.message
                }
            });
        }
        
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                error: {
                    code: 'TOKEN_EXPIRED',
                    message: 'JWT token has expired',
                    details: error.message
                }
            });
        }

        logger.error('Token verification error', { error: error.message });
        res.status(500).json({
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Internal server error',
                details: 'Token verification failed'
            }
        });
    }
});

app.post('/api/payments/refund', validateRefundRequest, async (req, res) => {
    try {
        const { transactionId, amount } = req.body;

        // Find the original transaction
        const transaction = await Transaction.findOne({ transactionId });
        
        if (!transaction) {
            return res.status(404).json({
                error: {
                    code: 'TRANSACTION_NOT_FOUND',
                    message: 'Transaction not found',
                    details: `No transaction found with ID: ${transactionId}`
                }
            });
        }

        if (transaction.status === 'refunded') {
            return res.status(409).json({
                error: {
                    code: 'ALREADY_REFUNDED',
                    message: 'Transaction already refunded',
                    details: `Transaction ${transactionId} has already been refunded`
                }
            });
        }

        if (amount > transaction.amount) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_REFUND_AMOUNT',
                    message: 'Refund amount exceeds original transaction amount',
                    details: `Refund amount $${amount} exceeds transaction amount $${transaction.amount}`
                }
            });
        }

        // Create refund record
        const refund = new Refund({
            transactionId,
            amount,
            status: 'pending'
        });

        await refund.save();

        // Update transaction status
        transaction.status = 'refunded';
        transaction.refundedAt = new Date();
        await transaction.save();

        // Update refund status
        refund.status = 'completed';
        refund.processedAt = new Date();
        await refund.save();

        metrics.refunds_processed++;

        logger.info('Refund processed successfully', { 
            refundId: refund.refundId,
            transactionId,
            amount
        });

        res.status(201).json({ 
            success: true,
            refundId: refund.refundId,
            transactionId,
            amount
        });
    } catch (error) {
        metrics.errors_total++;
        logger.error('Refund processing error', { error: error.message, stack: error.stack });
        res.status(500).json({
            error: {
                code: 'INTERNAL_ERROR',
                message: 'Internal server error',
                details: 'Refund could not be processed'
            }
        });
    }
});

app.post('/api/admin/transactions/clear', async (req, res) => {
    try {
        const result = await Transaction.deleteMany({});
        
        logger.info('All transactions cleared', { deletedCount: result.deletedCount });
        
        res.json({ 
            success: true,
            message: 'All transactions cleared',
            deletedCount: result.deletedCount
        });
    } catch (error) {
        metrics.errors_total++;
        logger.error('Failed to clear transactions', { error: error.message });
        res.status(500).json({
            error: {
                code: 'CLEAR_FAILED',
                message: 'Failed to clear transactions',
                details: error.message
            }
        });
    }
});

// Vulnerable payment validation endpoint
// Intentionally undocumented in Swagger: Internal validation functionality
app.post('/api/payments/validate', (req, res) => {
    try {
        const { input } = req.body;
        
        if (!input) {
            return res.status(400).json({
                error: {
                    code: 'MISSING_INPUT',
                    message: 'Input parameter is required',
                    details: 'No input provided for validation'
                }
            });
        }
        
        if (!_.isString(input)) {
            return res.status(422).json({
                error: {
                    code: 'INVALID_INPUT_TYPE',
                    message: 'Input must be a string',
                    details: `Expected string, got ${typeof input}`
                }
            });
        }
        
        res.json({ 
            status: 'success',
            message: 'Input validation passed',
            inputLength: input.length
        });
    } catch (error) {
        metrics.errors_total++;
        logger.error('Validation endpoint error', { error: error.message });
        res.status(500).json({
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Validation failed',
                details: error.message
            }
        });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Payment service running on port ${PORT}`);
}); 