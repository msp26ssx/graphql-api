import fetch from 'node-fetch'

require('dotenv').config()
require('util')

// DATABASE SETUP
const uri = 'mongodb://' + process.env.MONGODB_USERNAME + ':' + process.env.MONGODB_PASSWORD + '@unininja-cluster-shard-00-00-d1bwx.mongodb.net:27017,' + 'unininja-cluster-shard-00-01-d1bwx.mongodb.net:27017,' + 'unininja-cluster-shard-00-02-d1bwx.mongodb.net:27017' + '/uni?ssl=true&replicaSet=unininja-cluster-shard-0&authSource=admin'

// GRAPHQL SETUP
let database = null
let dbConnection = null

const {readFileSync} = require('fs')
const {makeExecutableSchema} = require('graphql-tools')
const express = require('express')
const graphqlHTTP = require('express-graphql')
const app = express()
const MongoClient = require('mongodb').MongoClient

const schema = makeExecutableSchema({
  typeDefs: readFileSync('schema.graphql', 'utf8'),
  resolvers: {
    Query: {
      // The querys that are avaliable to the client side.
      university: (obj, args, context) => getUniversity(args.pubukprn),
      universities: () => getUniversities(),
      courseList: (obj, args, context) => getCourses(args.pubukprn),
      course: (obj, args, context) => getCourseInfo(args.pubukprn, args.kiscourseid, args.isFullTime)
    },
    University: {
      // Adds the courses for a university as per the schema.
      courses: (obj, args, context) => getCourses(obj.pubukprn)
    }
  }
})

/**
  * Returns a list of all universities with their Name & pubukprn.
  * @return {Object}  promise - The json list of all universities.
  */

function getUniversities () {
  const promise = fetch('https://data.unistats.ac.uk/api/v4/KIS/Institutions.json?pageSize=1000', {
    headers: {
      'Authorization': `Basic ${process.env.UNISTATS_AUTH}`
    }
  }).then(function (response) {
    return response.json()
  }).then(function (myJson) {
    let myUniList = myJson

    // (Potentially) REMOVE/FILTER INSTITUTIONS THAT ARE NOT UNIVERSITIES

    // FORMAT THE DATA
    let uniReturnList = []
    for (let i = 0; i < myUniList.length; i++) {
      let innerUniJson = {}
      innerUniJson.pubukprn = myUniList[i].UKPRN
      innerUniJson.name = myUniList[i].Name
      uniReturnList.push(innerUniJson)
    }
    return uniReturnList
  })
  return promise
}

/**
  * Gets specific information for the requested university from MongoDB & Unistats.
  * @param {string} pubukprn - The university identifier.
  * @return {JSON OBJECT} promise - the JSON oject of university information.
  */

function getUniversity (pubukprn) {
  // Sussex pubukprn 10007806
  const promise = fetch('http://data.unistats.ac.uk/api/v4/KIS/Institution/' + pubukprn + '.json', {
    headers: {
      'Authorization': 'Basic ' + process.env.UNISTATS_AUTH
    }
  }).then(function (response) {
    // returns the succeeded promise to the next .then()
    return response.json()
  }).then(res => {
    console.log('RES: ' + res)

    const uniStatsResponse = res
    let newJson = {}
    newJson.pubukprn = uniStatsResponse.UKPRN
    newJson.name = uniStatsResponse.Name
    newJson.unionURL = uniStatsResponse.StudentUnionUrl

    return newJson
  }).then(resUniStats => {
    const query = {
      pubukprn: resUniStats.pubukprn
    }

    return database.collection('uni').findOne(query).then(university => {
      return new Promise((resolve, reject) => {
        console.log('UNIVERSITY: ' + university)
        resolve([university, resUniStats])
      })
    })
  }).then(finalRes => {
    // console.log('FINAL RES 0: ' + finalRes[0])
    // console.log('FINAL RES 1: ' + finalRes[1])

    const dbPromise = finalRes[0]
    let finalResJson = finalRes[1]

    if (dbPromise) {
      finalResJson.url = dbPromise.url
      finalResJson.color = dbPromise.color
      finalResJson.lat = dbPromise.lat
      finalResJson.lon = dbPromise.lon
      finalResJson.averageRent = dbPromise.averageRent
      finalResJson.uniLocationType = dbPromise.uniLocationType
      finalResJson.uniType = dbPromise.uniType
      finalResJson.nearestTrainStation = dbPromise.nearestTrainStation
    }

    console.log(JSON.stringify(finalResJson))

    return finalResJson
  }).then(finalResJson2 => {
    // Close the Database Connection.
    // mongoclient.close()
    return finalResJson2
  }).catch(err => console.log(err))
  return promise
}

/**
  * Gets all the courses for a specific university.
  * This will never usually be called by itself, but through a university.
  * @param {string} pubukprn - The university identifier.
  * @return {Array[Objects]} promise - An array of JSON objects for courses for the university.
  */

function getCourses (pubukprn) {
  // Sussex pubukprn 10007806
  const promise = fetch('http://data.unistats.ac.uk/api/v4/KIS/Institution/' + pubukprn + '/Courses.json?pageSize=300', {
    headers: {
      'Authorization': 'Basic ' + process.env.UNISTATS_AUTH
    }
  }).then(function (response) {
    // returns the succeeded promise to the next .then()
    return response.json()
  }).then(res => {
    console.log('RES: ' + res)

    const uniStatsResponse = res
    let newJson = []

    for (let i = 0; i < uniStatsResponse.length; i++) {
      let newInnerJson = {}
      newInnerJson.title = uniStatsResponse[i].Title
      newInnerJson.kiscourseid = uniStatsResponse[i].KisCourseId
      newInnerJson.isFullTime = uniStatsResponse[i].KisMode
      newJson.push(newInnerJson)
    }

    return newJson
  }).catch(err => console.log(err))
  return promise
}

const send401Unauthorized = (res) => {
  res.status(401).set('WWW-Authenticate', 'Basic realm=\'UniNinja API\'').send({
    'errors': [
      {
        'message': 'You must be authorised to use the UniNinja API.'
      }
    ]
  })
}

const send503ServerError = (res, msg) => {
  const message = msg || 'An internal server error occurred whilst using the UniNinja API. Please try again later.'
  res.status(503).send({
    'errors': [
      {
        'message': message
      }
    ]
  })
}

app.use('/v0', (req, res, next) => {
  console.log('Connection initiated')
  MongoClient.connect(uri).then(connection => {
    console.log('Connection succeeded')
    dbConnection = connection
    database = connection.db(process.env.MONGODB_DATABASE)
    next()
  }).catch(err => {
    console.log('Connection failed: ' + err.message)
    send503ServerError(res, err.message)
  })
})

app.use('/v0', (req, res, next) => {
  const authHeader = req.get('Authorization')
  if (authHeader) {
    const apiKey = Buffer.from(authHeader.substring(6), 'base64').toString().split(':', 1)[0]
    console.log('Db before', database)
    database.collection('keys').find({key: apiKey}).toArray(function (err, result) {
      if (err) {
        send503ServerError(res, err.message)
      } else {
        if (result.length > 0) {
          next()
        } else {
          send401Unauthorized(res)
        }
      }
    })
    console.log('Db after', database)
  } else {
    send401Unauthorized(res)
  }
})

/**
  * Gets specific information for the requested university from MongoDB & Unistats.
  * @param {string} pubukprn - The university identifier.
  * @param {string} kiscourseid - The course identifier.
  * @return {JSON OBJECT} promise - the JSON oject of course information.
  */

function getCourseInfo (pubukprn, kiscourseid, FullTime) {
  // Using sussexMComp as a default;
  // Sussex pubukprn = 10007806
  // Computer Science MComp = 37310

  return fetch('http://data.unistats.ac.uk/api/v4/KIS/Institution/' + pubukprn + '/Course/' + kiscourseid + '/' + FullTime + '.json', {
    headers: {
      'Authorization': 'Basic ' + process.env.UNISTATS_AUTH
    }
  }).then(function (response) {
    // returns the succeeded promise to the next .then()
    return response.json()
  }).then(function (myJson) {
    return new Promise((resolve, reject) => {
      let placement = false
      let yearAbroad = false

      if (myJson.SandwichAvailable > 0) {
        placement = true
      }
      if (myJson.YearAbroadAvaliable > 0) {
        yearAbroad = true
      }

      // console.log('COURSE INFO:     ' + myJson.Title)

      // CREATE JSON TO RETURN;
      let returnJson = {}

      returnJson.title = myJson.Title + ' ' + myJson.KisAimLabel
      returnJson.kiscourseid = kiscourseid
      returnJson.isFullTime = FullTime
      returnJson.courseURL = myJson.CoursePageUrl

      if (myJson.LengthInYears) {
        returnJson.years = parseInt(myJson.LengthInYears)
      }

      returnJson.placementYearAvaliable = placement
      returnJson.yearAbroadAvaliable = yearAbroad
      returnJson.degreeLabel = myJson.KisAimLabel
      returnJson.isHons = myJson.Honours

      // console.log(JSON.stringify(returnJson))

      if (returnJson) {
        console.log('JSON RETURNED?:  YES')
        resolve(returnJson)
      } else {
        console.log('JSON RETURNED?:  NO :(')
        reject(new Error('Something went wrong but the promise flagged it up'))
      }
    })
  })
}

const {PassThrough} = require('stream')

function graphqlMiddlewareWrapper (graphqlMiddleware) {
  return (req, res, next) => {
    const resProxy = new PassThrough()
    resProxy.headers = new Map()
    resProxy.statusCode = 200
    resProxy.setHeader = (name, value) => {
      resProxy.headers.set(name, value)
    }
    res.graphqlResponse = (cb) => {
      res.statusCode = resProxy.statusCode
      resProxy.headers.forEach((value, name) => {
        res.setHeader(name, value)
      })
      resProxy.pipe(res).on('finish', cb)
    }
    graphqlMiddleware(req, resProxy).then(() => next(), next)
  }
}

app.use('/v0', graphqlMiddlewareWrapper(graphqlHTTP({schema, graphiql: true})), (req, res, next) => {
  dbConnection.close()
  console.log('Database connection closed')
  res.graphqlResponse(next)
})

app.get('/', (req, res) => {
  res.redirect('https://uni.ninja')
})

// run server on port 3000
app.listen('3000', _ => console.log('Server is listening on port 3000...'))
