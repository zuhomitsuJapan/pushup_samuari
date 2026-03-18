self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'PushUp Live', body: 'Neue Aktivität im Team.' };
  event.waitUntil(self.registration.showNotification(data.title || 'PushUp Live', {
    body: data.body || 'Neue Aktivität im Team.',
    icon: '/icon-192.png',
    badge: '/icon-192.png'
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});
