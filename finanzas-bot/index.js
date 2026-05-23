require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai'); 

// 1. Conexión a MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('🟢 Conectado exitosamente a MongoDB Atlas'))
    .catch(err => console.error('🔴 Error conectando a MongoDB:', err));

// 2. Definir el Esquema y Modelo
const transaccionSchema = new mongoose.Schema({
    tipo: { type: String, enum: ['gasto', 'ingreso', 'transferencia'], required: true },
    cantidad: { type: Number, required: true },
    cantidadRecibida: { type: Number }, 
    concepto: { type: String, required: true },
    cuenta: { type: String, enum: ['efectivo', 'arq', 'BBVA', 'ahorros'], required: true },
    cuentaDestino: { type: String, enum: ['efectivo', 'arq', 'BBVA', 'ahorros'] }, 
    fecha: { type: Date, default: Date.now }
});

const Transaccion = mongoose.model('Transaccion', transaccionSchema);

// 3. Inicializamos las APIs externas (Gemini y ExchangeRate)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ✅ MEJORA 3: Caché para el tipo de cambio (evita llamadas repetidas a la API externa)
let cacheDolar = { valor: null, timestamp: 0 };

async function obtenerTipoCambio() {
    const CINCO_MINUTOS = 5 * 60 * 1000;
    if (cacheDolar.valor && (Date.now() - cacheDolar.timestamp < CINCO_MINUTOS)) {
        return cacheDolar.valor;
    }
    try {
        const response = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
        const data = await response.json();
        cacheDolar = { valor: data.rates.MXN, timestamp: Date.now() };
        return cacheDolar.valor;
    } catch (error) {
        console.error('Error al obtener el dólar:', error);
        return cacheDolar.valor || 17.00; // Usa el último valor conocido antes del fallback fijo
    }
}

// 4. Inicializar el Bot de Telegram
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => {
    ctx.reply('¡Hola! Soy tu bot de finanzas impulsado por IA.\n\nPuedes hablarme normal, por ejemplo:\n"Me gasté 150 en tacos de mi BBVA"\n"Transfiere 50 dólares físicos al cochinito"\n"Editar BBVA a 250"');
});

// ✅ MEJORA 1: Función auxiliar para calcular saldos usando aggregation de MongoDB
// En lugar de traer TODAS las transacciones a JS y sumar ahí, MongoDB hace el trabajo
async function calcularSaldos() {
    const resultado = await Transaccion.aggregate([
        {
            $group: {
                _id: null,
                efectivo: {
                    $sum: {
                        $switch: {
                            branches: [
                                { case: { $and: [{ $eq: ['$tipo', 'ingreso'] }, { $eq: ['$cuenta', 'efectivo'] }] }, then: '$cantidad' },
                                { case: { $and: [{ $eq: ['$tipo', 'gasto'] }, { $eq: ['$cuenta', 'efectivo'] }] }, then: { $multiply: ['$cantidad', -1] } },
                                { case: { $and: [{ $eq: ['$tipo', 'transferencia'] }, { $eq: ['$cuenta', 'efectivo'] }] }, then: { $multiply: ['$cantidad', -1] } },
                                { case: { $and: [{ $eq: ['$tipo', 'transferencia'] }, { $eq: ['$cuentaDestino', 'efectivo'] }] }, then: { $ifNull: ['$cantidadRecibida', '$cantidad'] } },
                            ],
                            default: 0
                        }
                    }
                },
                arq: {
                    $sum: {
                        $switch: {
                            branches: [
                                { case: { $and: [{ $eq: ['$tipo', 'ingreso'] }, { $eq: ['$cuenta', 'arq'] }] }, then: '$cantidad' },
                                { case: { $and: [{ $eq: ['$tipo', 'gasto'] }, { $eq: ['$cuenta', 'arq'] }] }, then: { $multiply: ['$cantidad', -1] } },
                                { case: { $and: [{ $eq: ['$tipo', 'transferencia'] }, { $eq: ['$cuenta', 'arq'] }] }, then: { $multiply: ['$cantidad', -1] } },
                                { case: { $and: [{ $eq: ['$tipo', 'transferencia'] }, { $eq: ['$cuentaDestino', 'arq'] }] }, then: { $ifNull: ['$cantidadRecibida', '$cantidad'] } },
                            ],
                            default: 0
                        }
                    }
                },
                BBVA: {
                    $sum: {
                        $switch: {
                            branches: [
                                { case: { $and: [{ $eq: ['$tipo', 'ingreso'] }, { $eq: ['$cuenta', 'BBVA'] }] }, then: '$cantidad' },
                                { case: { $and: [{ $eq: ['$tipo', 'gasto'] }, { $eq: ['$cuenta', 'BBVA'] }] }, then: { $multiply: ['$cantidad', -1] } },
                                { case: { $and: [{ $eq: ['$tipo', 'transferencia'] }, { $eq: ['$cuenta', 'BBVA'] }] }, then: { $multiply: ['$cantidad', -1] } },
                                { case: { $and: [{ $eq: ['$tipo', 'transferencia'] }, { $eq: ['$cuentaDestino', 'BBVA'] }] }, then: { $ifNull: ['$cantidadRecibida', '$cantidad'] } },
                            ],
                            default: 0
                        }
                    }
                },
                ahorros: {
                    $sum: {
                        $switch: {
                            branches: [
                                { case: { $and: [{ $eq: ['$tipo', 'ingreso'] }, { $eq: ['$cuenta', 'ahorros'] }] }, then: '$cantidad' },
                                { case: { $and: [{ $eq: ['$tipo', 'gasto'] }, { $eq: ['$cuenta', 'ahorros'] }] }, then: { $multiply: ['$cantidad', -1] } },
                                { case: { $and: [{ $eq: ['$tipo', 'transferencia'] }, { $eq: ['$cuenta', 'ahorros'] }] }, then: { $multiply: ['$cantidad', -1] } },
                                { case: { $and: [{ $eq: ['$tipo', 'transferencia'] }, { $eq: ['$cuentaDestino', 'ahorros'] }] }, then: { $ifNull: ['$cantidadRecibida', '$cantidad'] } },
                            ],
                            default: 0
                        }
                    }
                }
            }
        }
    ]);

    // Si no hay transacciones, retorna saldos en cero
    return resultado.length > 0 ? resultado[0] : { efectivo: 0, arq: 0, BBVA: 0, ahorros: 0 };
}

// 📌 5. COMANDOS: Balance Multidivisa
bot.command('balance', async (ctx) => {
    try {
        // ✅ MEJORA 1: Usa calcularSaldos() con aggregation en lugar de Transaccion.find()
        const saldos = await calcularSaldos();

        const totalPesos = saldos.efectivo + saldos.BBVA + saldos.ahorros;
        const totalDolares = saldos.arq;
        const precioDolar = await obtenerTipoCambio();
        const patrimonioGlobalMXN = totalPesos + (totalDolares * precioDolar);

        const mensajeBalance = `📊 *ESTADO DE CUENTAS*\n` +
            `💵 Dólar actual: $${precioDolar.toFixed(2)} MXN\n\n` +
            `🇲🇽 *Cuentas en Pesos (MXN)*\n` +
            `💵 Efectivo: $${saldos.efectivo.toFixed(2)}\n` +
            `🏦 BBVA: $${saldos.BBVA.toFixed(2)}\n` +
            `🐷 Ahorros: $${saldos.ahorros.toFixed(2)}\n` +
            `🔹 Total MXN: $${totalPesos.toFixed(2)}\n\n` +
            `🇺🇸 *Cuentas en Dólares (USD)*\n` +
            `🏢 ARQ: $${saldos.arq.toFixed(2)}\n` +
            `🔹 Total USD: $${totalDolares.toFixed(2)}\n` +
            `➖➖➖➖➖➖➖➖\n` +
            `💰 *PATRIMONIO TOTAL: $${patrimonioGlobalMXN.toFixed(2)} MXN*`;

        ctx.reply(mensajeBalance, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        ctx.reply('❌ Hubo un error al calcular tus saldos.');
    }
});

// ✅ MEJORA 4: Prompt extraído como función para mayor mantenibilidad
const buildPrompt = (mensajeUsuario) => `
Eres el backend de una app financiera. Analiza este mensaje del usuario y extrae los datos.

DICCIONARIO Y REGLAS ESTRICTAS:
1. Tipos de movimiento: 
   - "gasto": Si dice "compré", "pagué", "me costó", "gasté".
   - "ingreso": Si dice "me pagaron", "gané", "recibí".
   - "transferencia": Si mueve dinero entre sus propias cuentas.
   - "ajuste": Si el usuario dice "editar", "ajustar", "cambiar", o establece un nuevo balance/saldo final (ej. "editar BBVA 250", "mi saldo en banco es 200").
2. Cuentas válidas: "efectivo", "arq", "BBVA", "ahorros". (Si dice "banco" o "tarjeta" = BBVA. Si dice "dólares físicos" = arq. Si dice "cochinito" = ahorros).
3. Regla de oro: Si menciona un GASTO pero NO dice con qué pagó, asume AUTOMÁTICAMENTE que la cuenta es "efectivo".
4. Concepto: Si falta el concepto, usa "Varios". Si es un ajuste, usa "Ajuste manual".
5. IMPORTANTE PARA AJUSTES: Si el tipo es "ajuste", la "cantidad" DEBE SER el saldo FINAL EXACTO que el usuario quiere tener en esa cuenta.

Devuelve ÚNICAMENTE un objeto JSON válido, sin texto extra, con esta estructura:
{"tipo": "ajuste", "cantidad": 250, "concepto": "Ajuste manual", "cuenta": "BBVA", "cuentaDestino": null}

Mensaje del usuario: "${mensajeUsuario}"
`;

// ✅ MEJORA 5: Función de validación de la respuesta de Gemini antes de procesar
function validarDatosIA(datos) {
    const tiposValidos = ['gasto', 'ingreso', 'transferencia', 'ajuste'];
    const cuentasValidas = ['efectivo', 'arq', 'BBVA', 'ahorros'];

    if (!tiposValidos.includes(datos.tipo)) {
        throw new Error(`Tipo de transacción no reconocido: "${datos.tipo}"`);
    }
    if (typeof datos.cantidad !== 'number' || datos.cantidad <= 0) {
        throw new Error(`Cantidad inválida recibida: "${datos.cantidad}"`);
    }
    if (!cuentasValidas.includes(datos.cuenta)) {
        throw new Error(`Cuenta de origen no válida: "${datos.cuenta}"`);
    }
    if (datos.tipo === 'transferencia' && !cuentasValidas.includes(datos.cuentaDestino)) {
        throw new Error(`Cuenta destino no válida para transferencia: "${datos.cuentaDestino}"`);
    }
    if (datos.tipo === 'transferencia' && datos.cuenta === datos.cuentaDestino) {
        throw new Error('La cuenta de origen y destino no pueden ser la misma.');
    }
}

// 📌 6. PROCESAMIENTO DE LENGUAJE NATURAL CON GEMINI AI
bot.on('text', async (ctx) => {
    const mensajeUsuario = ctx.message.text.trim();
    if (mensajeUsuario.startsWith('/')) return; // Ignorar comandos mal escritos

    const mensajeEspera = await ctx.reply('🤔 Analizando...');

    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-3.1-flash-lite",
            generationConfig: { responseMimeType: "application/json" }
        });

        // ✅ MEJORA 4: Usa la función buildPrompt en lugar del string hardcodeado
        const result = await model.generateContent(buildPrompt(mensajeUsuario));
        const respuestaIA = result.response.text();
        const datosGenerados = JSON.parse(respuestaIA);

        // ✅ MEJORA 5: Valida los datos antes de cualquier lógica de negocio
        validarDatosIA(datosGenerados);

        let transaccionData = null;
        let mensajeRespuesta = "";
        let nuevaTransaccion = null;

        // 🧮 LÓGICA 1: GASTOS E INGRESOS
        if (datosGenerados.tipo === 'gasto' || datosGenerados.tipo === 'ingreso') {
            transaccionData = {
                tipo: datosGenerados.tipo,
                cantidad: datosGenerados.cantidad,
                concepto: datosGenerados.concepto || 'Varios',
                cuenta: datosGenerados.cuenta
            };
            const icono = transaccionData.tipo === 'ingreso' ? '📈' : '📉';
            mensajeRespuesta = `${icono} ¡${transaccionData.tipo.toUpperCase()} Guardado!\n💰 $${transaccionData.cantidad} en ${transaccionData.concepto}\n🏦 Cuenta: ${transaccionData.cuenta.toUpperCase()}`;
        
        // 🧮 LÓGICA 2: TRANSFERENCIAS
        } else if (datosGenerados.tipo === 'transferencia') {
            const cuentasMXN = ['efectivo', 'BBVA', 'ahorros'];
            const origenEsMXN = cuentasMXN.includes(datosGenerados.cuenta);
            const destinoEsMXN = cuentasMXN.includes(datosGenerados.cuentaDestino);

            let cantidadFinal = datosGenerados.cantidad;
            let detalleConversion = "";

            if (origenEsMXN !== destinoEsMXN) {
                const precioDolar = await obtenerTipoCambio();
                if (origenEsMXN && !destinoEsMXN) {
                    const tasaVenta = precioDolar + 0.50;
                    cantidadFinal = datosGenerados.cantidad / tasaVenta;
                    detalleConversion = `\n💱 Tasa de cambio: $${tasaVenta.toFixed(2)}`;
                } else {
                    const tasaCompra = precioDolar - 0.50;
                    cantidadFinal = datosGenerados.cantidad * tasaCompra;
                    detalleConversion = `\n💱 Tasa de cambio: $${tasaCompra.toFixed(2)}`;
                }
            }

            transaccionData = {
                tipo: 'transferencia',
                cantidad: datosGenerados.cantidad,
                cantidadRecibida: parseFloat(cantidadFinal.toFixed(2)),
                concepto: 'Traspaso entre cuentas',
                cuenta: datosGenerados.cuenta,
                cuentaDestino: datosGenerados.cuentaDestino
            };
            
            mensajeRespuesta = `🔄 ¡TRANSFERENCIA Guardada!\n📤 Salió: ${datosGenerados.cantidad} (${datosGenerados.cuenta.toUpperCase()})\n📥 Entró: ${cantidadFinal.toFixed(2)} (${datosGenerados.cuentaDestino.toUpperCase()})${detalleConversion}`;
        
        // 🧮 LÓGICA 3: AJUSTES MANUALES
        } else if (datosGenerados.tipo === 'ajuste') {
            const cuentaObjetivo = datosGenerados.cuenta;
            const saldoDeseado = datosGenerados.cantidad;

            // ✅ MEJORA 2: Usa calcularSaldos() con aggregation en lugar de Transaccion.find()
            const saldos = await calcularSaldos();
            const saldoActual = saldos[cuentaObjetivo] || 0;

            const diferencia = saldoDeseado - saldoActual;

            if (diferencia === 0) {
                mensajeRespuesta = `✅ El saldo de *${cuentaObjetivo.toUpperCase()}* ya es de **$${saldoDeseado.toFixed(2)}**.\nNo se requiere ningún ajuste.`;
            } else {
                const tipoAjuste = diferencia > 0 ? 'ingreso' : 'gasto';
                const cantidadAjuste = Math.abs(diferencia);

                transaccionData = {
                    tipo: tipoAjuste,
                    cantidad: parseFloat(cantidadAjuste.toFixed(2)),
                    concepto: 'Ajuste manual de saldo',
                    cuenta: cuentaObjetivo
                };

                const iconoAjuste = diferencia > 0 ? '📈' : '📉';
                mensajeRespuesta = `✅ *SALDO ACTUALIZADO*\n🏦 Cuenta: ${cuentaObjetivo.toUpperCase()}\n💰 Nuevo saldo: *$${saldoDeseado.toFixed(2)}*\n\n_(${iconoAjuste} Ajuste interno de $${cantidadAjuste.toFixed(2)} aplicado)_`;
            }
        }

        // 💾 GUARDADO EN BASE DE DATOS
        let opcionesMensaje = { parse_mode: 'Markdown' };

        if (transaccionData) {
            nuevaTransaccion = new Transaccion(transaccionData);
            await nuevaTransaccion.save();
            
            opcionesMensaje.reply_markup = {
                inline_keyboard: [[ Markup.button.callback('❌ Borrar registro', `del_${nuevaTransaccion._id}`) ]]
            };
        }

        ctx.telegram.editMessageText(ctx.chat.id, mensajeEspera.message_id, null, mensajeRespuesta, opcionesMensaje);

    } catch (error) {
        console.error("Error procesando con IA:", error);
        // ✅ MEJORA 5: Mensaje de error más descriptivo si el fallo fue en la validación
        const mensajeError = error.message.startsWith('Tipo') || error.message.startsWith('Cantidad') || error.message.startsWith('Cuenta') || error.message.startsWith('La cuenta')
            ? `⚠️ No pude interpretar tu mensaje correctamente. Intenta ser más específico (ej: "Gasté 150 en comida de mi BBVA").`
            : `🚨 ERROR TÉCNICO: Verifica que hayas escrito una instrucción clara.`;
        ctx.telegram.editMessageText(ctx.chat.id, mensajeEspera.message_id, null, mensajeError);
    }
});

// 📌 7. LÓGICA DE BOTONES PARA BORRAR REGISTROS
bot.action(/^del_(.+)$/, async (ctx) => {
    const idTransaccion = ctx.match[1]; 
    try {
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

// 📌 8. ARRANQUE DEL BOT Y SERVIDOR WEB FANTASMA (PARA RENDER)
bot.launch();
console.log('🤖 Bot de finanzas corriendo con Inteligencia Artificial...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

const http = require('http');
const puerto = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('El Bot de Finanzas Inteligente esta activo 🤖🧠');
    res.end();
}).listen(puerto, () => {
    console.log(`🌐 Servidor web fantasma escuchando en el puerto ${puerto}`);
});