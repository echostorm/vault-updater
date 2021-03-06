/*
 *  Amazon S3 updater
 *
 *  This script handles the transfer of assets from the local machine to Amazon's S3 buckets.
 *
 *  To operate the following environment variables need to be set:
 *
 *    S3_KEY    - Amazon user access key
 *    S3_SECRET - Amazon secret user access key
 *    S3_REGION - Region identifier [us-east-1]
 *    S3_BUCKET - Bucket name
 *
 *  The S3_KEY and S3_SECRET are available from the IAM console in AWS
 */

var fs = require('fs')
var path = require('path')
var async = require('async')

var AWS = require('aws-sdk')

var channelData = require('../dist/common').channelData

var args = require('yargs')
    .usage('node tools/uploader.js --source=/full/directory/to/browser-laptop --send')
    .demand(['channel'])
    .default('source', '../browser-laptop')
    .default('send', false)
    .argv

if (!channelData[args.channel]) {
  throw new Error(`Invalid channel ${args.channel}`)
}

// Default bucket and region
const S3_BUCKET = process.env.S3_BUCKET || 'brave-download'
const S3_REGION = process.env.S3_REGION || 'us-east-1'

// Check that the source directory for the binary assets exists
if (!fs.existsSync(args.source)) {
  throw new Error(args.source + ' does not exist')
}

// Read in package.json
var pack = JSON.parse(fs.readFileSync(path.join(args.source, 'package.json'), 'utf-8'))
var version = pack.version

// Recipe pairs containing local relative paths to files and key locations on S3
var recipes = [
  ['dist/Brave.tar.bz2', 'multi-channel/releases/CHANNEL/VERSION/linux64'],
  ['dist/brave_VERSION_amd64.deb', 'multi-channel/releases/CHANNEL/VERSION/debian64'],
  ['dist/brave-VERSION.x86_64.rpm', 'multi-channel/releases/CHANNEL/VERSION/fedora64'],
  ['dist/Brave-VERSION.zip', 'multi-channel/releases/CHANNEL/VERSION/osx'],
  ['dist/Brave.dmg', 'multi-channel/releases/CHANNEL/VERSION/osx'],

  ['dist/x64/BraveSetup-x64.exe', 'multi-channel/releases/CHANNEL/VERSION/winx64'],
  ['dist/x64/BraveSetup-x64.msi', 'multi-channel/releases/CHANNEL/VERSION/winx64'],
  ['dist/x64/BraveSetup-x64.exe', 'multi-channel/releases/CHANNEL/winx64'],
  ['dist/x64/RELEASES', 'multi-channel/releases/CHANNEL/winx64'],
  ['dist/x64/brave-VERSION-full.nupkg', 'multi-channel/releases/CHANNEL/winx64'],

  ['dist/ia32/BraveSetup-ia32.exe', 'multi-channel/releases/CHANNEL/VERSION/winia32'],
  ['dist/ia32/BraveSetup-ia32.msi', 'multi-channel/releases/CHANNEL/VERSION/winia32'],
  ['dist/ia32/BraveSetup-ia32.exe', 'multi-channel/releases/CHANNEL/winia32'],
  ['dist/ia32/RELEASES', 'multi-channel/releases/CHANNEL/winia32'],
  ['dist/ia32/brave-VERSION-full.nupkg', 'multi-channel/releases/CHANNEL/winia32']
]

// For the dev channel we need to upload files to the legacy location. This will move them on to the dev
// mainline code where they will update from /multi-channel/releases/CHANNEL/winx64
if (args.channel === 'dev') {
  recipes = recipes.concat([
    ['dist/x64/BraveSetup-x64.exe', 'releases/winx64'],
    ['dist/x64/RELEASES', 'releases/winx64'],
    ['dist/x64/brave-VERSION-full.nupkg', 'releases/winx64']
  ])
}

// Replace VERSION in the recipes with the package version
recipes = recipes.map((recipe) => {
  var dist = recipe[0].replace('VERSION', version)
  dist = dist.replace('CHANNEL', args.channel)

  var multi = recipe[1].replace('VERSION', version)
  multi = multi.replace('CHANNEL', args.channel)
  
  return [dist, multi]
})

console.log(`Working with version: '${version}' on channel '${args.channel}'. Sending to bucket '${S3_BUCKET}'.`)

// Check for S3 env variables
if (!process.env.S3_KEY || !process.env.S3_SECRET) {
  throw new Error('S3_KEY or S3_SECRET environment variables not set')
}

AWS.config.update({
  accessKeyId: process.env.S3_KEY,
  secretAccessKey: process.env.S3_SECRET,
  region: S3_REGION,
  sslEnabled: true
})

// Return a function used to transfer a file to S3
var makeS3Uploader = (filename, s3Key) => {
  return (cb) => {
    // Check to see that the file exists
    if (fs.existsSync(filename)) {
      // Transfer parameters
      var params = {
        localFile: filename,
        s3Params: {
          Bucket: S3_BUCKET,
          Key: s3Key + '/' + path.basename(filename),
          ACL: 'public-read'
        }
      }
      console.log(params)

      var body = fs.createReadStream(filename)
      var s3obj = new AWS.S3({
        params: {
          Bucket: S3_BUCKET,
          Key: s3Key + '/' + path.basename(filename),
          ACL: 'public-read'
        }
      })

      var lastPercent = 0
      s3obj.upload({Body: body}).
        on('httpUploadProgress', function(evt) {
          var percent = Math.round(evt.loaded / evt.total * 100)
          if (lastPercent !== percent) {
            process.stdout.write(percent + '% ')
            lastPercent = percent
          }
        }).
        send((err, data) => {
          console.log('Done')
          console.log(data)
          cb(err)
        })

    } else {
      console.log('IGNORING - ' + filename + ' does not exist')
      cb(null)
    }
  }
}

// Return a function used to report on the status of a file
var makeReporter = (filename, recipe) => {
  return (cb) => {
    if (fs.existsSync(filename)) {
      console.log('OK       - ' + filename + ' exists -> ' + recipe)
    } else {
      console.log('IGNORING - ' + filename + ' does not exist')
    }
    cb(null)
  }
}

// Create array of function handlers
var recipeHandlers = recipes.map((recipe) => {
  var fullFilename = path.join(args.source, recipe[0])
  if (args.send) {
    return makeS3Uploader(fullFilename, recipe[1])
  } else {
    return makeReporter(fullFilename, recipe[1])
  }
})

// Call the function handlers
async.series(recipeHandlers, (err, handler) => {
  if (err) {
    throw new Error(err)
  }
  console.log("* Process complete")
})
