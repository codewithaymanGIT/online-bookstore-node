const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
require('dotenv').config();
const db = require('./config/db');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));

// Helper: get cart item count for navbar badge
function getCartCount(req) {
  const cart = req.session.cart || [];
  return cart.reduce((sum, item) => sum + item.qty, 0);
}

// Helper: require login
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

// Homepage
app.get('/', async (req, res) => {
  const [books] = await db.query('SELECT * FROM books LIMIT 4');
  res.render('index', {
    user: req.session.user || null,
    books,
    cartCount: getCartCount(req),
  });
});

// Catalogue
app.get('/catalogue', async (req, res) => {
  const [books] = await db.query('SELECT * FROM books');
  res.render('catalogue', {
    user: req.session.user || null,
    books,
    cartCount: getCartCount(req),
  });
});

// Book detail
app.get('/book/:id', async (req, res) => {
  const [rows] = await db.query('SELECT * FROM books WHERE id = ?', [req.params.id]);
  if (rows.length === 0) return res.status(404).send('Book not found');

  res.render('book-detail', {
    user: req.session.user || null,
    book: rows[0],
    cartCount: getCartCount(req),
  });
});

// Add to cart
app.post('/cart/add/:id', async (req, res) => {
  const bookId = parseInt(req.params.id);
  if (!req.session.cart) req.session.cart = [];

  const existing = req.session.cart.find(item => item.id === bookId);
  if (existing) {
    existing.qty += 1;
  } else {
    req.session.cart.push({ id: bookId, qty: 1 });
  }

  res.redirect('/cart');
});

// Update cart quantity
app.post('/cart/update/:id', (req, res) => {
  const bookId = parseInt(req.params.id);
  const cart = req.session.cart || [];
  const item = cart.find(i => i.id === bookId);

  if (item) {
    if (req.body.action === 'increase') item.qty += 1;
    if (req.body.action === 'decrease') item.qty = Math.max(1, item.qty - 1);
  }

  res.redirect('/cart');
});

// Remove from cart
app.post('/cart/remove/:id', (req, res) => {
  const bookId = parseInt(req.params.id);
  req.session.cart = (req.session.cart || []).filter(item => item.id !== bookId);
  res.redirect('/cart');
});

// View cart
app.get('/cart', async (req, res) => {
  const cart = req.session.cart || [];

  if (cart.length === 0) {
    return res.render('cart', {
      user: req.session.user || null,
      items: [],
      total: 0,
      cartCount: 0,
    });
  }

  const bookIds = cart.map(item => item.id);
  const [books] = await db.query(
    `SELECT * FROM books WHERE id IN (${bookIds.map(() => '?').join(',')})`,
    bookIds
  );

  const items = cart.map(cartItem => {
    const book = books.find(b => b.id === cartItem.id);
    return { ...book, qty: cartItem.qty };
  });

  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);

  res.render('cart', {
    user: req.session.user || null,
    items,
    total,
    cartCount: getCartCount(req),
  });
});

// Checkout - show form
app.get('/checkout', requireLogin, async (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) return res.redirect('/cart');

  const bookIds = cart.map(item => item.id);
  const [books] = await db.query(
    `SELECT * FROM books WHERE id IN (${bookIds.map(() => '?').join(',')})`,
    bookIds
  );

  const items = cart.map(cartItem => {
    const book = books.find(b => b.id === cartItem.id);
    return { ...book, qty: cartItem.qty };
  });

  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);

  res.render('checkout', {
    user: req.session.user,
    items,
    total,
  });
});

// Checkout - place order
app.post('/checkout', requireLogin, async (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) return res.redirect('/cart');

  const { name, address, city, pincode } = req.body;

  const bookIds = cart.map(item => item.id);
  const [books] = await db.query(
    `SELECT * FROM books WHERE id IN (${bookIds.map(() => '?').join(',')})`,
    bookIds
  );

  const items = cart.map(cartItem => {
    const book = books.find(b => b.id === cartItem.id);
    return { ...book, qty: cartItem.qty };
  });

  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);

  const [orderResult] = await db.query(
    `INSERT INTO orders (user_id, total, shipping_name, shipping_address, shipping_city, shipping_pincode)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [req.session.user.id, total, name, address, city, pincode]
  );

  const orderId = orderResult.insertId;

  for (const item of items) {
    await db.query(
      `INSERT INTO order_items (order_id, book_id, title, price, quantity) VALUES (?, ?, ?, ?, ?)`,
      [orderId, item.id, item.title, item.price, item.qty]
    );
  }

  req.session.cart = [];

  res.redirect(`/order-confirmation/${orderId}`);
});

// Order confirmation
app.get('/order-confirmation/:orderId', requireLogin, async (req, res) => {
  const [orderRows] = await db.query('SELECT * FROM orders WHERE id = ? AND user_id = ?', [
    req.params.orderId,
    req.session.user.id,
  ]);

  if (orderRows.length === 0) return res.status(404).send('Order not found');

  const [items] = await db.query('SELECT * FROM order_items WHERE order_id = ?', [req.params.orderId]);

  res.render('order-confirmation', {
    user: req.session.user,
    order: orderRows[0],
    items,
  });
});

// Order history
app.get('/orders', requireLogin, async (req, res) => {
  const [orders] = await db.query(
    'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC',
    [req.session.user.id]
  );

  res.render('orders', {
    user: req.session.user,
    orders,
  });
});

// Register - show form
app.get('/register', (req, res) => {
  res.render('register', { error: null });
});

// Register - handle submission
app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  try {
    const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.render('register', { error: 'An account with that email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await db.query(
      'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
      [name, email, hashedPassword]
    );

    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.render('register', { error: 'Something went wrong. Please try again.' });
  }
});

// Login - show form
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// Login - handle submission
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.render('login', { error: 'Invalid email or password.' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);

    if (!match) {
      return res.render('login', { error: 'Invalid email or password.' });
    }

    req.session.user = { id: user.id, name: user.name, email: user.email };
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Something went wrong. Please try again.' });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Marginalia running at http://localhost:${PORT}`));