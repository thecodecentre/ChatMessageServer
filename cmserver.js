/* Chat Message Server for H3G. 
 * This script should run under Node.js on local server
 */
// Version 0.1 15 May 2017
/* acronyms used in this script

*/
//****** Set up Express Server and socket.io
var http = require('http');
var https = require('https');
var app = require('express')();
var fs = require('fs');
var crypto = require('crypto');
var bodyParser = require('body-parser');
var dateFormat = require('dateformat');
var decode = require('decode-html');

app.use( bodyParser.json() );       // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
  extended: true
})); 

//****For Manji's local machine
/*const options = {
  pfx: fs.readFileSync('../sslcert/certificate.pfx'),
  passphrase: 'mango'
};
/*
//****for TechMBS
const options = {
  pfx: fs.readFileSync('boldchat_techmbs_in.pfx'),
  passphrase: '1'
}

var PORT = Number(443);
var server = https.createServer(options, app).listen(PORT);
var	io = require('socket.io').listen(server);
*/
//********** Get port used by Heroku or use a default
var PORT = Number(process.env.PORT || 7979);
var server = http.createServer(app).listen(PORT);
var	io = require('socket.io').listen(server);

//******* Get BoldChat API Credentials
console.log("Reading API variables from config.json file...");
const EndedReason = ["Unknown","Operator","Visitor","Disconnected"];
var EnVars;
var AID,SETTINGSID,KEY;

var STARTDAY;
var TriggerDomain = "https://boldchat.techmbs.in";		// used to validate the signature of push data

try
{
	EnVars = JSON.parse(fs.readFileSync('config.json', 'utf8'));
	AID = EnVars.AID || 0;
	SETTINGSID = EnVars.APISETTINGSID || 0;
	KEY = EnVars.APIKEY || 0;
	STARTDAY = EnVars.STARTOFDAY || {"hours":0,"minutes":0};	// contains hours and minutes (UTC)
}
catch(e)
{
	if(e.code === 'ENOENT')
	{
		console.log("Config file not found, Reading Heroku Environment Variables");
		AID = process.env.AID || 0;
		SETTINGSID = process.env.APISETTINGSID || 0;
		KEY = process.env.APIKEY || 0;
		STARTDAY = JSON.parse(process.env.STARTOFDAY) || {};
	}
	else
		console.log("Error code: "+e.code);
}

if(AID == 0 || SETTINGSID == 0 || KEY == 0)
{
	console.log("BoldChat API Environmental Variables not set. Terminating!");
	process.exit(1);
}

if(STARTDAY.hours > 23 || STARTDAY.hours < 0 || STARTDAY.minutes > 59 || STARTDAY.minutes < 0)
{
	console.log("Start of day time invalid - must from 00:00 to 23:59");
	process.exit(1);
}
console.log("Start of Day: "+ STARTDAY.hours+":"+STARTDAY.minutes+" UTC");
console.log("Config loaded successfully");

//****** Callbacks for all URL requests
app.get('/', function(req, res){
	res.sendFile(__dirname + '/index.html');
});
app.get('/index.js', function(req, res){
	res.sendFile(__dirname + '/index.js');
});
app.get('/jquery-2.1.3.min.js', function(req, res){
	res.sendFile(__dirname + '/jquery-2.1.3.min.js');
});
app.get('/bootstrap.min.css', function(req, res){
	res.sendFile(__dirname + '/bootstrap.min.css');
});

// Process incoming Boldchat triggered chat message
app.post('/chatMessage', function(req, res){
	Exceptions.chatMessages++;
	res.send({ "result": "success" });
//	if(validateSignature(req.body, TriggerDomain+'/chatMessage'))
	{
		sendToLogs("New Chat Message, chat id: "+req.body.ChatID);
		debugLog("New event",req.body);
		if(OperatorsSetupComplete)		//make sure all static data has been obtained first
			processChatMessage(req.body);
	}
});

// GET request used to test connectivity
app.get('/test', function(req, res){
	var str = "";
	res.send({"result": "success"});
	for(var key in req.query)
	{
		if(req.query.hasOwnProperty(key))
			str += key +":"+req.query[key]+",";
	}
	sendToLogs("Test Success: "+str);
});

process.on('uncaughtException', function (err) {
  console.log('Exception: ' + err);
});

// Set up socket actions and responses
io.on('connection', function(socket){
		
	socket.on('operatorRequest', function(data){
		socket.emit('operatorResponse',Operators);
	});	

	socket.on('departmentRequest', function(data){
		socket.emit('departmentResponse',Departments);
	});	

	// join room which does the report every 3 mins and multicasts it to all subscribers
	socket.on('join room',function(room){
		sendToLogs("Joining room "+room);
		sendToLogs("Listening to POST on url/chatMessage and GET on url/test");
		socket.join(room);
	});
	
	socket.on('disconnect', function(data){
		removeSocket(socket.id, "disconnect");
	});	
	socket.on('error', function(data){
		removeSocket(socket.id, "error");
	});
	socket.on('end', function(data){
		removeSocket(socket.id, "end");
	});
	socket.on('connect_timeout', function(data){
		removeSocket(socket.id, "timeout");
	});
});

//********************************* Global class exceptions
var Exception = function() {
		this.APIJsonError = 0;
		this.noJsonDataMsg = 0;
};

//******* Global class for operator info
var OpMetrics = function(opid,name) {
		this.operatorID = opid;
		this.operatorName = name;
		this.employeeID = getEmployeeIDfromName(name,opid);
		this.chatMessages = 0;		// daily chat messages
};

//******* Global class for chat message
var ChatMessage = function(chatid) {
//		this.id = "";
		this.chatID = chatid;
		this.deptName = "";
		this.name = "";
		this.date = ""; 	// date in YYYY-MMM-DD format
		this.time = "";		// time in hh:mm:ss:millis format
		this.text = "";		// the actual chat messages
};

//******************** Global constants for chat messages
const MONITORROOM = "monitor_room";		// socket room name for monitoring this service

//******************** Global variables for chat data
var	Departments;	// array of dept ids and dept name objects
var	Operators;	// array of operator ids and name objects
var AllChatMessages;
var ApiDataNotReady;	// Flag to show when data has been received from API so that data can be processed
var TimeNow;			// global for current time
var StartOfDay;			// global time for start of the day before all stats are reset
var EndOfDay;			// global time for end of the day before all stats are reset
var Exceptions;
var chatMsgTimerID;

console.log("Server started on port "+PORT);
doStartOfDay();		// initialise everything

/*******************************************
/* Functions below this point
********************************************/

function doStartOfDay() {
	initialiseGlobals();	// zero all memory
	getApiData("getDepartments",0,deptsCallback);
	sleep(100);
	getApiData("getOperators",0,operatorsCallback);
	sleep(100);
//	chatMsgTimerID = setInterval(updateChatMsgTimer,10000);
}

function sleep(milliseconds) {
	var start = new Date().getTime();
	for(var i = 0; i < 1e7; i++)
	{
		if((new Date().getTime() - start) > milliseconds)
		{
			break;
		}
	}
}

function cleanText(mytext) {
	if(typeof mytext !== 'string') return(mytext);
	var clean = mytext.replace(/<\/?[^>]+(>|$)/g, "");	// take out html tags
	var clean2 = clean.replace(/(\r\n|\n|\r)/g,"");	// take out new lines
	var clean3 = clean2.replace(/["']/g,"");	// take out single and double quotes
	console.log("Clean Text: "+clean3);
	return(clean3);
}

function validateSignature(body, triggerUrl) {

	var unencrypted = getUnencryptedSignature(body, triggerUrl);
	var encrypted = encryptSignature(unencrypted);
//	console.log('unencrypted signature', unencrypted);
//	console.log('computed signature: '+ encrypted);
//	console.log('trigger signature: '+ body.signature);
	if(encrypted == body.signature)
		return true;

	var str = "Trigger signature validation error: "+triggerUrl;
	Exceptions.signatureInvalid++;
	sendToLogs(str);
//	debugLog(triggerUrl,body);
	return true;	// true while testing - change to false afterwards
}

function getUnencryptedSignature(body, triggerUrl) {
	if (!body.signed) {
		throw new Error('No signed parameter found for computing signature hash');
	}
	var signatureParamNames = body.signed.split('&');

	var paramNameValues = new Array();
	for (var i = 0; i < signatureParamNames.length; i++) {
		var signParam = signatureParamNames[i];
		paramNameValues.push(encodeURIComponent(signParam) + '=' + encodeURIComponent(body[signParam]));
	}

	var separator = triggerUrl.indexOf('?') === -1 ? '?' : '&';
	var unc = triggerUrl + separator + paramNameValues.join('&');
	var adj = unc.replace(/%20/g,'+');		// %20 to a + (old style)
	return adj.replace(/\'/g,'%27');	// ' should be encoded (old style)
}

function encryptSignature(unencryptedSignature) {
	var source = unencryptedSignature + KEY;
	var hash = crypto.createHash('sha512').update(source).digest('hex');
	return hash.toUpperCase();
}

// returns the emplyee id from operator name in format "[sup name] nnnnnn_opname"
function getEmployeeIDfromName(name,opid) {
	var regex = /[0-9]+/;
	var eid = name.match(regex);
	if(eid != null)
	{
		if(eid > 9999)		// make sure this is an employee ID
		{
//			console.log("EID - "+eid);
			return eid;
		}
	}
	return opid;
}

// returns the employee id from operator ID 
function getEmployeeIDfromOperatorID(opid) {
	
	var eid = Operators[opid];
	if(typeof eid === 'undefined')
		return opid;

	return(Operators[opid].employeeID);
}

// returns the the date from ISO date 
function getDateFromISODate(isodate) {
	
	var date = dateFormat(isodate,"yyyy-mmm-dd");
	return(date);
}

// returns the the date from ISO date 
function getTimeFromISODate(isodate) {
	
	var time = dateFormat(isodate,"HH:MM:ss:l");
	return(time);
}

function initialiseGlobals () {
	Departments = new Object();
	Operators = new Object();
	AllChatMessages = new Array();
	TimeNow = new Date();
	StartOfDay = new Date();
	StartOfDay.setUTCHours(STARTDAY.hours,STARTDAY.minutes,0,0);
	if(StartOfDay > TimeNow)
		StartOfDay.setDate(StartOfDay.getDate() - 1)	// previous day if past midnight but before start of day time
	EndOfDay = new Date();
	EndOfDay.setTime(StartOfDay.getTime() + ((24*60*60*1000) - 1));	// 24 hours less one milli from start of day 
	console.log("Start of Day: "+StartOfDay.toISOString());
	console.log("End of Day: "+EndOfDay.toISOString());
	OperatorsSetupComplete = false;
	ApiDataNotReady = 0;
	Exceptions = new Exception();
}

// Set up code for outbound BoldChat API calls.  All of the capture callback code should ideally be packaged as an object.

function BC_API_Request(api_method,params,callBackFunction) {
	var auth = AID + ':' + SETTINGSID + ':' + (new Date()).getTime();
	var authHash = auth + ':' + crypto.createHash('sha512').update(auth + KEY).digest('hex');
	var options = {
		host : 'api-eu.boldchat.com',
		port : 443,
		path : '/aid/'+AID+'/data/rest/json/v1/'+api_method+'?auth='+authHash+'&'+params,
		method : 'GET',
		agent : false
	};
//	https.request(options, callBackFunction).on('error', function(err){console.log("API request error: "+err.stack)}).end();
	ApiDataNotReady++;		// flag to track api calls
	var getReq = https.request(options, function(res) {
//		console.log("\nstatus code: ", res.statusCode);
		var str = "";
		res.on('data', function(data) {
			str += data;
		});
		res.on('end', function() {
			ApiDataNotReady--;
			callBackFunction(str);
		});
		res.on('error', function(err){
			ApiDataNotReady--;
			console.log("API request error: ", err);
		});
	});
    //end the request
    getReq.end();
}

function debugLog(name, dataobj) {
	console.log(name+": ");
	for(key in dataobj)
	{
		if(dataobj.hasOwnProperty(key))
			console.log(key +":"+dataobj[key]);
	}
}

function sendToLogs(text) {
	console.log(text);
	io.sockets.in(MONITORROOM).emit('consoleLogs',text);
//	io.emit('consoleLogs', text);
}

function deptsCallback(dlist) {
	var dname,newname,str,sg,ch1,ch2,ch3;
// sort alphabetically first
	dlist.sort(function(a,b) {
		var nameA=a.Name.toLowerCase();
		var nameB=b.Name.toLowerCase();
		if (nameA < nameB) //sort string ascending
			return -1;
		if (nameA > nameB)
			return 1;
		return 0; //default return value (no sorting)
	});

	for(var i in dlist)
	{
		dname = dlist[i].Name;
/*		sg = dname.match("^\\[(.*)]");	// match square brackets at beginning
		if(sg === null) continue;		// dept name does not match a skillgroup in square brackets
		ch1 = dname.indexOf("[");
		ch2 = dname.indexOf("]");
		sg = dname.substring(ch1+1,ch2);	// name between the brackets
		if((ch2+1) >= dname.length) continue;
		str = dname.substring(ch2+1);		// remainder of the name
		if(str === null) continue;		// ignore if nothing after the square brackets
		ch3 = str.match("[A-Za-z0-9]+").index;
		newname = str.substring(ch3);*/
//		console.log("Dept saved: "+newname);
		Departments[dlist[i].DepartmentID] = dname;
	}
	sendToLogs("No of Depts: "+Object.keys(Departments).length);
}

function operatorsCallback(dlist) {
// sort alphabetically first
	dlist.sort(function(a,b) {
		var nameA=a.Name.toLowerCase();
		var nameB=b.Name.toLowerCase();
		if (nameA < nameB) //sort string ascending
			return -1;
		if (nameA > nameB)
			return 1;
		return 0; //default return value (no sorting)
	});

	for(var i in dlist)
	{
		Operators[dlist[i].LoginID] = new OpMetrics(dlist[i].LoginID,dlist[i].Name);																			
	}
	sendToLogs("No of Operators: "+Object.keys(Operators).length);
	OperatorsSetupComplete = true;
}


// this function calls API again if data is truncated
function loadNext(method,next,callback,params) {
	var str = [];
	for(var key in next) {
		if (next.hasOwnProperty(key)) {
			str.push(encodeURIComponent(key) + "=" + encodeURIComponent(next[key]));
		}
	}
	getApiData(method,str.join("&"),callback,params);
}

// calls extraction API and receives JSON objects
function getApiData(method,params,fcallback,cbparam) {
	var emsg;
	BC_API_Request(method,params,function(str)
	{
		var jsonObj;
		try
		{
			jsonObj = JSON.parse(str);
		}
		catch (e)
		{
			Exceptions.APIJsonError++;
			emsg = TimeNow+ ": API did not return JSON message: "+str;
			sendToLogs(emsg);
			return;
		}
		var data = new Array();
		data = jsonObj.Data;
		if(data === 'undefined' || data == null)
		{
			Exceptions.noJsonDataMsg++;
			emsg = TimeNow+ ":"+method+": No data: "+str;
			sendToLogs(emsg);
			return;
		}
		fcallback(data, cbparam);

		var next = jsonObj.Next;
		if(typeof next !== 'undefined')
		{
			loadNext(method,next,fcallback,cbparam);
		}
	});
}

function objectToCsv(cmobj) {
	var str = "";
	for(var key in cmobj)
	{
		str = str +"\""+cmobj[key]+ "\",";
	}
//	str += "\r\n";
	return(str);
}

function getCsvChatMsgs() {
	var key, value;
	var csvChats = "";
	var tchat = new Object();
	// add csv header using first object
	key = Object.keys(AllChatMessages)[0];
	tchat = AllChatMessages[key];
	for(key in tchat)
	{
		csvChats = csvChats +key+ ",";
	}
	csvChats = csvChats + "\r\n";
	// now add the data
	for(var i in AllChatMessages)
	{
		tchat = AllChatMessages[i];
		for(key in tchat)
		{
			csvChats = csvChats +"\""+tchat[key]+ "\",";
		}
		csvChats = csvChats + "\r\n";
	}
	return(csvChats);
}

function processChatMessage(cMsg) {
	var cmobj = new ChatMessage(cMsg.ChatID);
	cmobj.deptName = Departments[cMsg.DepartmentID];
	if(cMsg.EndedReasonType == "")	// this is a message not chat ended event
	{
		if(cMsg.CMPersonType == 1)		// if visitor sent this
			cmobj.name = cMsg.CMName;
		else							// operator message
			cmobj.name = getEmployeeIDfromOperatorID(cMsg.OperatorID);
		
		cmobj.date = getDateFromISODate(cMsg.CMCreated);
		cmobj.time = getTimeFromISODate(cMsg.CMCreated);
		cmobj.text = cleanText(decode(cMsg.CMText));
//		console.log("Text: "+decode(cMsg.CMText));
	}
	else
	{
		cmobj.date = getDateFromISODate(cMsg.Ended);
		cmobj.time = getTimeFromISODate(cMsg.Ended);		
		cmobj.text = cMsg.ChatID + "_"+EndedReason[cMsg.EndedReasonType]+"_ended_chat";	
	}
//	debugLog("CMObject",cmobj);
	AllChatMessages.push(cmobj);
	io.sockets.in(MONITORROOM).emit('chatMessage',cmobj);
//	DBInsert(cmobj);
	var csv = objectToCsv(cmobj);
	postToFile(csv);
}

function removeSocket(id, evname) {
	sendToLogs("Socket "+evname+" at "+ TimeNow);
}

function updateChatMsgTimer() {

	if(!OperatorsSetupComplete) return;		//try again later

	TimeNow = new Date();		// update the time for all calculations
	if(TimeNow > EndOfDay)		// we have skipped to a new day
	{
		sendToLogs(TimeNow.toISOString()+": New day started, stats reset");
		clearInterval(chatMsgTimerID);
		setTimeout(doStartOfDay,10000);	//restart after 10 seconds to give time for ajaxes to complete
		return;
	}
	postToFile(getCsvChatMsgs);
}

function postToFile(postdata) {
	var options = {
		host : 'uber-electronics.com', 
		port : 443, 
		path : '/home/mkerai/APItriggers/cmtestmessages.php', 
		method : 'POST',
		headers: {
          'Content-Type': 'text/plain',
          'Content-Length': Buffer.byteLength(postdata)
		}
	};
	var post_req = https.request(options, function(res){
		res.setEncoding('utf8');
		res.on('data', function (chunk) {
//			console.log('Response: ' + chunk);
			});
		});
	post_req.write(postdata);
	post_req.end();
	post_req.on('error', function(err){console.log("HTML error"+err.stack)});
	sendToLogs("Post to file complete");
}

