require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;

// Configuración de CORS y parseo de JSON
app.use(cors());
app.use(express.json());

// Cliente de Supabase (usando la llave de servicio para poder hacer bypass al RLS desde el backend)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY // <-- CAMBIAR AQUÍ
);

// Middleware para verificar el Token JWT enviado desde el frontend de React
const verificarAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Falta el token de autorización' });
    }

    const token = authHeader.split(' ')[1];

    // Supabase verifica si el token es válido y no ha expirado
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }

    // Guardamos los datos del usuario en la request para usarlo en las rutas
    req.user = user;
    next();
};

// ==========================================
// RUTAS CRUD DE GASTOS
// ==========================================

// 1. LEER (GET) - Obtener todos los gastos del usuario autenticado
app.get('/api/gastos', verificarAuth, async (req, res) => {
    const { data, error } = await supabase
        .from('gastos')
        .select('*')
        .eq('user_id', req.user.id)
        .order('fecha', { ascending: false }); // Ordenar por fecha más reciente

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 2. CREAR (POST) - Registrar un nuevo gasto
app.post('/api/gastos', verificarAuth, async (req, res) => {
    const { fecha, categoria, monto, descripcion } = req.body;

    const { data, error } = await supabase
        .from('gastos')
        .insert([
            {
                user_id: req.user.id, // Asignamos el gasto al usuario logueado
                fecha,
                categoria,
                monto,
                descripcion
            }
        ])
        .select(); // Devolvemos el registro recién creado

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data[0]);
});

// 3. ACTUALIZAR (PUT) - Modificar un gasto existente
app.put('/api/gastos/:id', verificarAuth, async (req, res) => {
    const { id } = req.params;
    const { fecha, categoria, monto, descripcion } = req.body;

    const { data, error } = await supabase
        .from('gastos')
        .update({ fecha, categoria, monto, descripcion })
        .eq('id', id)
        .eq('user_id', req.user.id) // Capa de seguridad: asegurar que sea su propio gasto
        .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data[0]);
});

// 4. ELIMINAR (DELETE) - Borrar un gasto
app.delete('/api/gastos/:id', verificarAuth, async (req, res) => {
    const { id } = req.params;

    const { error } = await supabase
        .from('gastos')
        .delete()
        .eq('id', id)
        .eq('user_id', req.user.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ mensaje: 'Gasto eliminado correctamente' });
});

// Levantar el servidor
app.listen(port, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${port}`);
});

// Inicializar Gemini con la API Key del .env
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Endpoint de Chat Financiero Inteligente
app.post('/api/chat', verificarAuth, async (req, res) => {
    const { pregunta } = req.body;

    try {
        // 1. Obtener el salario neto del usuario desde 'perfiles'
        const { data: perfil } = await supabase
            .from('perfiles')
            .select('salario_neto')
            .eq('id', req.user.id)
            .single();

        const salarioNeto = perfil?.salario_neto || 0;

        // 2. Obtener los gastos del usuario desde 'gastos'
        const { data: gastos, error } = await supabase
            .from('gastos')
            .select('fecha, categoria, monto, descripcion')
            .eq('user_id', req.user.id);

        if (error) throw error;

        // 3. Estructurar el contexto unificado (Ingresos + Gastos)
        const contextoFinanciero = {
            salario_neto_mensual: salarioNeto,
            gastos: gastos
        };

        const prompt = `
Eres un asesor financiero personal experto. Responde a la duda del usuario basándote EXCLUSIVAMENTE en sus datos reales registrados.

DATOS FINANCIEROS DEL USUARIO (en formato JSON):
${JSON.stringify(contextoFinanciero, null, 2)}

PREGUNTA DEL USUARIO:
"${pregunta}"

INSTRUCCIONES:
- Considera tanto el "salario_neto_mensual" como la lista de "gastos" para realizar tus análisis y recomendaciones.
- Si el usuario pregunta por su saldo disponible o capacidad de ahorro, resta la suma total de sus gastos a su salario neto mensual.
- Sé preciso, amable y directo en tus cálculos.
    `;

        // 4. Llamar a la API de Gemini (asegúrate de usar el modelo que te funcionó)
        const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });
        const result = await model.generateContent(prompt);
        const respuesta = await result.response.text();

        res.json({ respuesta });
    } catch (err) {
        console.error('Error en /api/chat:', err);
        res.status(500).json({ error: 'No se pudo generar la respuesta de la IA' });
    }
});
// ==========================================
// RUTAS DE PERFIL / CONFIGURACIÓN
// ==========================================

// OBTENER PERFIL
// OBTENER PERFIL
app.get('/api/perfil', verificarAuth, async (req, res) => {
    let { data, error } = await supabase
        .from('perfiles')
        .select('*')
        .eq('id', req.user.id)
        .single();

    if (!data && error?.code === 'PGRST116') {
        const defaultSalarios = { "01": 0, "02": 0, "03": 0, "04": 0, "05": 0, "06": 0, "07": 0, "08": 0, "09": 0, "10": 0, "11": 0, "12": 0 };
        const { data: newPerfil, error: insertError } = await supabase
            .from('perfiles')
            .insert([{ id: req.user.id, salario_neto: 0, salarios_mensuales: defaultSalarios }])
            .select()
            .single();

        if (insertError) return res.status(500).json({ error: insertError.message });
        return res.json(newPerfil);
    }

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ACTUALIZAR SALARIOS MENSUALES
app.put('/api/perfil', verificarAuth, async (req, res) => {
    const { salarios_mensuales, salario_neto } = req.body;

    const { data, error } = await supabase
        .from('perfiles')
        .update({ salarios_mensuales, salario_neto })
        .eq('id', req.user.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ACTUALIZAR SALARIO
app.put('/api/perfil', verificarAuth, async (req, res) => {
    const { salario_neto } = req.body;

    const { data, error } = await supabase
        .from('perfiles')
        .update({ salario_neto })
        .eq('id', req.user.id) // <-- Usando 'id'
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});