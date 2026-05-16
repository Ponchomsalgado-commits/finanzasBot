require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');

// 1. Conexión a MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Conectado exitosamente a MongoDB Atlas'))
    .catch(err => console.error('🔴 Error conectando a MongoDB:', err));

// 2. Definir el Esquema y Modelo
const transaccionSchema = new mongoose.Schema({
    tipo: { type: String, enum: ['gasto', 'ingreso', 'transferencia'], required: true },
    cantidad: { type: Number, required: true },
    concepto: { type: String, required: true },
    cuenta: { type: String, enum: ['efectivo', 'arq', 'banorte', 'ahorros'], required: true },
    cuentaDestino: { type: String, enum: ['efectivo', 'arq', 'banorte', 'ahorros'] }, // Solo para transferencias
    fecha: { type: Date, default: Date.now }
});

const Transaccion = mongoose.model('Transaccion', transaccionSchema);

// 3. Inicializar el Bot
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => {
    ctx.reply('¡Hola! Soy tu bot de finanzas.\n\nFormato: [gasto/ingreso] [cantidad] [concepto] [método]\nTransferencia: transferencia [cantidad] [cuenta_origen] a [cuenta_destino]');
});

// 📌 4. COMANDOS ESPECÍFICOS PRIMERO (Para que no se confundan con texto normal)
// Comando para consultar el Balance Múltiple



bot.command('balance', async (ctx) => {
    try {
        // Traemos todas las transacciones
        const transacciones = await Transaccion.find();

        // Inicializamos los saldos en 0
        let saldos = {
            efectivo: 0,
            arq: 0,
            banorte: 0,
            ahorros: 0
        };

        // Procesamos la matemática cuenta por cuenta
        transacciones.forEach(t => {
            if (t.tipo === 'ingreso') {
                saldos[t.cuenta] += t.cantidad;
            } else if (t.tipo === 'gasto') {
                saldos[t.cuenta] -= t.cantidad;
            } else if (t.tipo === 'transferencia') {
                saldos[t.cuenta] -= t.cantidad; // Sale de la cuenta origen
                saldos[t.cuentaDestino] += t.cantidad; // Entra a la cuenta destino
            }
        });

        const totalGlobal = saldos.efectivo + saldos.arq + saldos.banorte + saldos.ahorros;

        // Armamos el mensaje final
        const mensajeBalance = `📊 *ESTADO DE CUENTAS*\n\n` +
            `💵 Efectivo:    $${saldos.efectivo.toFixed(2)}\n` +
            `⬜ ARQ:          $${saldos.arq.toFixed(2)}\n` +
            `🟥 Banorte:    $${saldos.banorte.toFixed(2)}\n` +
            `🐷 Ahorros:    $${saldos.ahorros.toFixed(2)}\n` +
            `➖➖➖➖➖➖➖➖\n` +
            `💰 *PATRIMONIO TOTAL: $${totalGlobal.toFixed(2)}*`;

        ctx.reply(mensajeBalance, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error(error);
        ctx.reply('❌ Hubo un error al calcular tus saldos.');
    }
});

// 📌 5. LECTOR DE TEXTO NORMAL DESPUÉS
// Lógica principal: Recibir y Guardar
bot.on('text', async (ctx) => {
    const mensaje = ctx.message.text.trim();

    // Regex para GASTOS o INGRESOS (ej: gasto 150 tacos banorte)
    const regexNormal = /^(gasto|ingreso)\s+(\d+(?:\.\d{1,2})?)\s+(.+)\s+(efectivo|arq|banorte|ahorros)$/i;
    // Regex para TRANSFERENCIAS (ej: transferencia 500 banorte a ahorros)
    const regexTransferencia = /^transferencia\s+(\d+(?:\.\d{1,2})?)\s+(efectivo|arq|banorte|ahorros)\s+a\s+(efectivo|arq|banorte|ahorros)$/i;

    let transaccionData = null;
    let mensajeRespuesta = "";

    if (regexNormal.test(mensaje)) {
        const coincidencia = mensaje.match(regexNormal);
        transaccionData = {
            tipo: coincidencia[1].toLowerCase(),
            cantidad: parseFloat(coincidencia[2]),
            concepto: coincidencia[3].trim(),
            cuenta: coincidencia[4].toLowerCase()
        };
        const icono = transaccionData.tipo === 'ingreso' ? '📈' : '📉';
        mensajeRespuesta = `${icono} ¡${transaccionData.tipo.toUpperCase()} Guardado!\n💰 $${transaccionData.cantidad} en ${transaccionData.concepto}\n🏦 Cuenta: ${transaccionData.cuenta.toUpperCase()}`;
    
    } else if (regexTransferencia.test(mensaje)) {
        const coincidencia = mensaje.match(regexTransferencia);
        transaccionData = {
            tipo: 'transferencia',
            cantidad: parseFloat(coincidencia[1]),
            concepto: 'Traspaso entre cuentas',
            cuenta: coincidencia[2].toLowerCase(), // De dónde sale el dinero
            cuentaDestino: coincidencia[3].toLowerCase() // A dónde entra
        };
        mensajeRespuesta = `🔄 ¡TRANSFERENCIA Guardada!\n💰 $${transaccionData.cantidad}\n📤 De: ${transaccionData.cuenta.toUpperCase()}\n📥 A: ${transaccionData.cuentaDestino.toUpperCase()}`;
    }

    // Si detectó un formato válido, lo guarda en BD
    if (transaccionData) {
        try {
            const nuevaTransaccion = new Transaccion(transaccionData);
            await nuevaTransaccion.save();

            ctx.reply(mensajeRespuesta, Markup.inlineKeyboard([
                Markup.button.callback('❌ Borrar registro', `del_${nuevaTransaccion._id}`)
            ]));
        } catch (error) {
            console.error(error);
            ctx.reply('❌ Error al guardar en la base de datos.');
        }
    } else {
        ctx.reply('❌ Formato incorrecto.\nNormal: gasto 150 tacos banorte\nTransferencia: transferencia 500 banorte a ahorros');
    }
});

// 📌 6. LÓGICA DE BOTONES Y ARRANQUE AL FINAL
// Lógica para Borrar usando el ID de MongoDB
bot.action(/^del_(.+)$/, async (ctx) => {
    const idTransaccion = ctx.match[1]; // Extraemos el ID de MongoDB

    try {
        // Buscamos y eliminamos el documento en la base de datos
        const transaccionBorrada = await Transaccion.findByIdAndDelete(idTransaccion);

        if (transaccionBorrada) {
            ctx.editMessageText('🗑️ Registro eliminado de la base de datos exitosamente.');
        } else {
            ctx.editMessageText('⚠️ Este registro ya había sido eliminado o no se encontró.');
        }
    } catch (error) {
        console.error(error);
        ctx.answerCbQuery('Error al intentar borrar el registro.');
    }
});

bot.launch();
console.log('🤖 Bot de finanzas corriendo...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));