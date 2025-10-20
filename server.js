import {Mongo} from 'meteor/mongo';
Meteor.otps = new Mongo.Collection('__otps');
// Meteor.otps.rawCollection().createIndex({phone: 1, purpose: 1}, {unique: true, name: 'phoneAndPurpose'});

const otpPurpose = '__login__';

///
/// ERROR HANDLER
///
const handleError = ({errCode = 403, msg, throwError, details}) => {
	throwError = typeof throwError === 'undefined' ? true : throwError;
	let error = new Meteor.Error(
		errCode,
		Accounts._options.ambiguousErrorMessages
			? 'Login failure. Please check your login credentials.'
			: msg,
		details
	);
	if (throwError) {
		throw error;
	}
	return error;
};

Accounts.sanitizePhone = async function(phone) {
	check(phone, String);
	if (!phone) return null;

	const nums = phone.split(/,|;/);
	for (var i = 0; i < nums.length; i++) {
		// trim and remove all hyphens, spaces
		const ph = nums[i].replace(/[^\d^+]/g, '').replace(/^0+/g, '');
		if (!ph) continue;
		const {parse} = await import('libphonenumber-js');
		const res = parse(ph);
		if (!res.country) continue;
		return ph;
	}
	return null;
};


///
/// LOGIN
///
/**
 * @summary finds user by doing a phone number search. Throws error if multiple found.
 * @param {String} phone phone number.
 * @param {String} expectedUserId the user id which is expected for this phone. It is needed because phone numbers may not be unique, and at times we may need to check if the login is for an expected old user or a new user.
 * @return {Object} user document
 */
Accounts.findUserByPhone = async function(phone, expectedUserId) {
	check(phone, String);
	check(expectedUserId, Match.Maybe(String));
	phone = await Accounts.sanitizePhone(phone);
	if (!phone) return null;
	const users = await Meteor.users.find({phones: {$elemMatch: {number: phone, verified: true}}}).fetchAsync();
	if (users.length > 1) throw new Meteor.Error(403, 'Multiple users with same phone');
	if (expectedUserId && users.length && users[0]._id !== expectedUserId) throw new Meteor.Error('unexpected-user', 'Already a user exists with this number.');
	return users[0] || null;
};

// Handler to login with a phone and otp.
/**
 * @summary adds a login handler for phone or an Object into an array,if not already present
 * @param {Object/String} value to be added.
 * @return {Object} object with user_id, and data that is to be inserted while creating user
 */
Accounts.registerLoginHandler('phone', async function(options) {
	if (!options.phone || !options.otp) return undefined; // eslint-disable-line no-undefined
	let verified = false;
	try {
		check(options, {phone: String, otp: String, purpose: Match.Maybe(String), expectedUserId: Match.Optional(Match.Maybe(String))});
		let {phone, otp, purpose, expectedUserId} = options;

		const phn = await Accounts.verifyPhoneOtp({phone, otp, purpose});
		if (phn) verified = true;

		const user = await Accounts.findUserByPhone(phone, expectedUserId);
		if (!user) {
			const userId = await createUser({phone});
			return {userId};
		}
		return {userId: user._id};
	}
	catch (e) {
		e.details = e.details || {};
		return {userId: null, error: handleError({errCode: e.error, msg: e.reason || JSON.stringify(e), details: {...e.details, verified}})};
	}
});

/**
 * @summary Set the otp for a user.
 * @locus Server
 * @param {String} phone phone number.
 * @param {String} otp OTP
 * @returns {Void} null
 */
Accounts.setPhoneOtp = async function(phone, otp) {
	check([phone, otp], [String]);
	phone = await Accounts.sanitizePhone(phone);
	if (!phone) throw new Meteor.Error(403, 'Improper phone number');
	await Meteor.otps.removeAsync({phone, purpose: otpPurpose});
	await Meteor.otps.insertAsync({phone, otp, purpose: otpPurpose, createdAt: new Date()});
};

/**
 * @summary Verify the otp for a user.
 * @locus Server
 * @param {String} phone phone number.
 * @param {String} otp OTP
 * @returns {String} Sanitized phone number
 */
Accounts.verifyPhoneOtp = async function({phone, otp, purpose = ''}) {
	check([phone, otp, purpose], [String]);
	if (!purpose) purpose = otpPurpose;
	phone = await Accounts.sanitizePhone(phone);
	if (!phone) throw new Meteor.Error(500, 'Invalid phone number');
	const otpDoc = await Meteor.otps.findOneAsync({phone, purpose});
	if (!otpDoc) throw new Meteor.Error(403, 'User has no otp set');
	if (otpDoc.otp !== otp) throw new Meteor.Error(403, 'Incorrect otp');

	//mark exisiting user verified
	const user = await Meteor.users.find({'phones.number': phone}).fetchAsync();
	if (user.length === 1) {
		await Meteor.users.updateAsync({'phones.number': phone}, {$set: {'phones.$.verified': true}});
	}

	await Meteor.otps.removeAsync({phone: phone, purpose});
	return phone;
};

/**
 * @summary Add a phone number for a user. Use this instead of directly
 * updating the database. The operation will fail if there is a different user
 * with same phone.
 * @locus Server
 * @param {String} userId The ID of the user to update.
 * @param {String} newPhone A new phone number for the user.
 * @param {Boolean} [verified] Optional - whether the new phone number should
 * be marked as verified. Defaults to false.
 * @returns {Void} null
 */
Accounts.addPhone = async function(userId, newPhone, verified) {
	verified = typeof verified === 'undefined' ? false : verified;

	check(userId, String);
	check(newPhone, String);
	check(verified, Boolean);

	const user = await Meteor.users.findOneAsync(userId);
	if (!user) throw new Meteor.Error(403, 'User not found');

	newPhone = await Accounts.sanitizePhone(newPhone);
	if (!newPhone) throw new Meteor.Error(500, 'Invalid phone number');
	if (await Meteor.users.findOneAsync({'phones.number': phone})) throw new Meteor.Error(500, 'User exists with given phone number');
	await Meteor.users.updateAsync({_id: user._id}, {$addToSet: {phones: {number: newPhone, verified}}});
};

/**
 * @summary Remove an phone number for a user. Use this instead of updating
 * the database directly.
 * @locus Server
 * @param {String} userId The ID of the user to update.
 * @param {String} phone The phone number to remove.
 * @returns {Void} null
 */
Accounts.removePhone = async function(userId, phone) {
	check(userId, String);
	check(phone, String);

	const user = await Meteor.users.findOneAsync(userId);
	if (!user) throw new Meteor.Error(403, 'User not found');

	phone = await Accounts.sanitizePhone(phone);
	if (!phone) throw new Meteor.Error(500, 'Invalid phone number');
	await Meteor.users.updateAsync({_id: user._id}, {$pull: {phones: {number: phone}}});
};

///
/// CREATING USERS
///

// Shared createUser function called from the createUser method, both
// if originates in client or server code. Calls user provided hooks,
// does the actual user insertion.
//
// returns the user id
const createUser = async function(options) {
	// Unknown keys allowed, because a onCreateUserHook can take arbitrary
	// options.
	check(options, {phone: String});

	const {phone} = options;
	const user = {username: phone, services: {phone: {number: phone}}, phones: [{number: phone, verified: true}]};

	// here its failing without phone object
	const userId = await Accounts.insertUserDoc({phone: phone}, user);
	if (!userId) throw new Meteor.Error(500, 'Failed to insert new user');

	// Perform another check after insert, in case a matching user has been
	// inserted in the meantime
	if (await Meteor.users.findOneAsync({_id: {$ne: userId}, 'phones.number': phone})) {
		// Remove inserted user if the check fails
		await Meteor.users.removeAsync(userId);
		throw new Meteor.Error(500, 'User exists with given phone number');
	}
	return userId;
};

///
/// PASSWORD-SPECIFIC INDEXES ON USERS
///
// Meteor.users._ensureIndex('phones.number', {unique: 1, sparse: 1});
