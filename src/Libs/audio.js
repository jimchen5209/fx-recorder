const spawn = require('child_process').spawn;
const Stream = require('stream');

function soundFileStreamGenerator(filePath, debug) {
    const outputStream = spawn('ffmpeg', [
        '-hide_banner',
        '-v', '-9',
        '-i', filePath,
        '-f', 's16le',
        '-ac', '2',
        '-acodec', 'pcm_s16le',
        '-ar', '48000',
        '-y', 'pipe:1'
    ]);

    // if (debug) {
        outputStream.stderr.on("data", data => console.log(data.toString()));
    // } else {
    //     outputStream.stderr.on("data", data => { });
    // }

    return (outputStream.stdout);
}

async function addStreamToChannelPlayMixer(stream, mixer) {
    // const source = new Stream.PassThrough();
    mixer.addSource(stream);
    // mixer.addSource(source);
    // stream.on("data", (data) => {
    //     source.write(data);
    // });
    // stream.on("end", () => {
    //     source.end();
    // });
}

function generatePCMtoMP3Stream(stream, debug) {
    const outputStream = spawn('ffmpeg', [
        '-hide_banner',
        '-v', '-9',
        '-f', 's16le', // 16-bit raw PCM
        '-ac', 2, // in channels
        '-ar', 48000, // in sample rate
        '-i', '-', // stdin
        '-c:a', 'libmp3lame', //  LAME MP3 encoder
        '-ac', 2, // out channels
        '-ar', 48000, // out sample rate
        '-ab', '320k', // bitrate
        '-f', 'mp3', // MP3 container
        '-' // stdout
    ]);

    // if (debug) {
        outputStream.stderr.on("data", data => console.log(data.toString()));
    // } else {
    //     outputStream.stderr.on("data", data => { });
    // }

    stream.pipe(outputStream.stdin);
    stream.on('close', () => outputStream.kill("SIGINT"))

    return (outputStream.stdout);
}

module.exports = {
    soundFileStreamGenerator,
    addStreamToChannelPlayMixer,
    generatePCMtoMP3Stream
}
