const { createApp } = require('./app');

const port = process.env.PORT || 3000;
createApp().listen(port, () => {
  console.log(`CRM app running at http://localhost:${port}`);
  console.log('Data is stored in memory and resets on restart.');
});
