/*
 * Optimized native function of mixing different buffers
 * This implementation reduces CPU usage and call latency
*/

#include <napi.h>
#include <stdint.h>
#include <cmath>
#include <vector>
#include <new>

using namespace Napi;

namespace NativeMixingOperation {
	struct SourceInfo {
		double volume;
		int64_t transitionLength;
		int64_t transitionCurrent;
		double transitionFrom;
		double transitionTo;
		char* buffer;
	};
	
	// Max value lookup map to speed up GetMaxSampleValue
	uint32_t maxValues[4] = {
		(1U << 7) - 1,
		(1U << 15) - 1,
		(1U << 23) - 1,
		(1U << 31) - 1
	};
	std::vector<uint32_t> maxValueLookup(&maxValues[0], &maxValues[0] + 4);
	
	// Lookup tables
	const size_t TableSize = 4000;
	std::vector<double> EasingLookup;
	
	double MixSample(double a, double b) {
		return (1.0 - fabs(a * b)) * (a + b);
	}
	
	uint32_t GetMaxSampleValue(unsigned int byteSize) {
		return maxValueLookup[byteSize - 1];
	}
	
	double EasingFunction(double x) {
		return x * x * x;
	}
	
	double Easing(double x, double from, double to) {
		// Do a clamp to prevent out of bounds access (and Segfaults)
		if(x > 1.0) x = 1.0;
		if(x < 0.0) x = 0.0;
		
		uint32_t i = (uint32_t)floor(x * (TableSize - 1));
		return from + EasingLookup[i] * (to - from);
	}

	double ReadSample(char* p, unsigned int byteSize) {
		double sample = 0.0;
		uint32_t max = GetMaxSampleValue(byteSize);
		int32_t rawValue = 0;
		
		// Assuming signed little-endian for all types
		switch (byteSize) {
			case 1:
				rawValue = !(*p & 0x80) ? (int32_t)*p : (int32_t)(0xff - *p + 1) * -1;
			break;
			
			case 2:
				rawValue = (int32_t)((int16_t)((*p & 0xff) | (*(p + 1) << 8 & 0xff00)));
			break;
			
			case 3:
				rawValue = (int32_t)((*(p + 2) & 0x80) << 24 | *(p + 2) << 16 & 0x7fffff | *(p + 1) << 8 & 0xffff | *p & 0xff);
			break;

			case 4:
				rawValue = (int32_t)(
					(*p & 0xff) |
					(*(p + 1) << 8 & 0xff00) |
					(*(p + 2) << 16 & 0xff0000) |
					(*(p + 3) << 24 & 0xff000000)
				);
			break;
		}

		sample = (double)rawValue / (double)max;
		return sample;
	}
	
	void WriteSample(char* p, double value, unsigned int byteSize) {
		if(value > 1.0) value = 1.0;
		if(value < -1.0) value = -1.0;
		
		uint32_t max = GetMaxSampleValue(byteSize);
		int32_t val = 0;
		val = value * max;
		
		// Assuming signed little-endian for all types
		switch (byteSize) {
			case 1:
				*p = val & 0xff;
			break;
			
			case 2:
				*p = val & 0xff;
				*(p + 1) = val >> 8 & 0xff;
			break;
			
			case 3:
				*p = val & 0xff;
				*(p + 1) = val >> 8 & 0xff;
				*(p + 2) = val >> 16 & 0xff | (val < 0 ? 0x80 : 0);
			break;

			case 4:
				*p = val & 0xff;
				*(p + 1) = val >> 8 & 0xff;
				*(p + 2) = val >> 16 & 0xff;
				*(p + 3) = val >> 24 & 0xff;
			break;
		}
	}

	Value Mix(const CallbackInfo &args) {
		Env env = args.Env();
		if (args.Length() < 5) {
			TypeError::New(env, "Usage: mix(buf[], src[], length, bitdepth, channels)").ThrowAsJavaScriptException();
			return env.Null();
		}
		
		if (!args[0].IsArray()) {
			TypeError::New(env, "Buffers must be an array!").ThrowAsJavaScriptException();
			return env.Null();
		}
		
		if (!args[1].IsArray()) {
			TypeError::New(env, "Sources must be an array!").ThrowAsJavaScriptException();
			return env.Null();
		}
		
		if (!args[2].IsNumber()) {
			TypeError::New(env, "Length must be a number!").ThrowAsJavaScriptException();
			return env.Null();
		}
		
		if (!args[3].IsNumber()) {
			TypeError::New(env, "Bit depth must be a number!").ThrowAsJavaScriptException();
			return env.Null();
		}
		
		if (!args[4].IsNumber()) {
			TypeError::New(env, "Channels must be a number!").ThrowAsJavaScriptException();
			return env.Null();
		}
		
		Array bufArray = args[0].As<Array>();
		Array srcArray = args[1].As<Array>();
		unsigned int length = args[2].As<Number>().Uint32Value();
		unsigned int bitdepth = args[3].As<Number>().Uint32Value();
		unsigned int channels = args[4].As<Number>().Uint32Value();
		unsigned int sampleSize = bitdepth / 8 * channels;
		unsigned int byteSize = bitdepth / 8;
		
		if (bitdepth % 8 != 0) {
			Error::New(env, "Bit depth must be a multiple of 8!").ThrowAsJavaScriptException();
			return env.Null();
		}
		
		if (byteSize > 4) {
			Error::New(env, "Unsupported bit depth!").ThrowAsJavaScriptException();
			return env.Null();
		}

		Buffer<char> output = Buffer<char>::New(env, length);
		char* outputBuffer = output.Data();

		std::vector<SourceInfo*> sources;

		for (uint32_t i = 0; i < bufArray.Length(); i++) {
			Object src = srcArray.Get(i).As<Object>();
			Buffer<char> buf = bufArray.Get(i).As<Buffer<char>>();
			SourceInfo* source = new SourceInfo;
			source->volume = src.Get("volume").As<Number>().DoubleValue();
			source->transitionLength = src.Get("transitionLength").As<Number>().Int64Value();
			source->transitionCurrent = src.Get("transitionCurrent").As<Number>().Int64Value();
			source->transitionFrom = src.Get("transitionFrom").As<Number>().DoubleValue();
			source->transitionTo = src.Get("transitionTo").As<Number>().DoubleValue();
			source->buffer = buf.Data();
			sources.push_back(source);
		}

		for (uint32_t offset = 0; offset < length; offset += byteSize) {
			double value = 0.0;
			for (uint32_t i = 0; i < sources.size(); i++) {
				// Process fading
				if (offset % sampleSize == 0 && sources[i]->transitionLength >= 0) {
					sources[i]->transitionCurrent++;
					sources[i]->volume = Easing(
						(double)(sources[i]->transitionCurrent) / (double)(sources[i]->transitionLength),
						sources[i]->transitionFrom,
						sources[i]->transitionTo
					);
					
					if (sources[i]->transitionCurrent >= sources[i]->transitionLength) {
						sources[i]->volume = sources[i]->transitionTo;
						sources[i]->transitionLength = -1;
					}
				}

				char* buffer = sources[i]->buffer;
				double sample = ReadSample(buffer + offset, byteSize) * sources[i]->volume;
				value = MixSample(value, sample);
			}

			// Write the new mixed sample
			WriteSample(outputBuffer, value, byteSize);
			outputBuffer += byteSize;
		}

		for (uint32_t i = 0; i < sources.size(); i++) {
			Object src = srcArray.Get(i).As<Object>();
			src.Set("volume", sources[i]->volume);
			src.Set("transitionLength", sources[i]->transitionLength);
			src.Set("transitionCurrent", sources[i]->transitionCurrent);
			src.Set("transitionFrom", sources[i]->transitionFrom);
			src.Set("transitionTo", sources[i]->transitionTo);

			free(sources[i]);
		}

		sources.erase(sources.begin(), sources.end());
		return output;
	}

	Object Init(Env env, Object exports) {
		for (double i = 0; i < TableSize; i++) {
			EasingLookup.push_back(EasingFunction(i / (TableSize - 1)));
		}

  		return Function::New(env, Mix);
	}

	NODE_API_MODULE(mix, Init)
}
