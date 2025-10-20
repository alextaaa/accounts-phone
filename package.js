Package.describe({
	name: 'local:accounts-phone',
	version: '2.0.1',
	summary: 'A login service based on mobile number and otp, For Meteor.'
});

Package.onUse(function(api) {
	api.versionsFrom('METEOR@3.0.2');
	api.use('ecmascript');
	api.use('mongo');
	api.use('accounts-base', ['client', 'server']);
	api.imply('accounts-base', ['client', 'server']);
	api.use('check');
	api.use('ddp', ['client', 'server']);
	api.addFiles('server.js', 'server');
	api.addFiles('client.js', 'client');
});
