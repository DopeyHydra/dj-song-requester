# Build-Umgebung für die Android-App: JDK 17 + Android SDK + Gradle.
# Nutzung: siehe build-apk.sh
FROM eclipse-temurin:17-jdk-jammy

ENV ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_HOME=/opt/android-sdk \
    GRADLE_HOME=/opt/gradle
ENV PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$GRADLE_HOME/bin

RUN apt-get update && apt-get install -y --no-install-recommends unzip wget && rm -rf /var/lib/apt/lists/*

# Android Command-line Tools
RUN mkdir -p $ANDROID_SDK_ROOT/cmdline-tools \
 && wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O /tmp/clt.zip \
 && unzip -q /tmp/clt.zip -d /tmp/clt && mv /tmp/clt/cmdline-tools $ANDROID_SDK_ROOT/cmdline-tools/latest \
 && rm -rf /tmp/clt /tmp/clt.zip

RUN yes | sdkmanager --licenses > /dev/null \
 && sdkmanager "platform-tools" "platforms;android-35" "build-tools;34.0.0" "build-tools;35.0.0" > /dev/null

# Gradle
RUN wget -q https://services.gradle.org/distributions/gradle-8.11.1-bin.zip -O /tmp/gradle.zip \
 && unzip -q /tmp/gradle.zip -d /opt && mv /opt/gradle-8.11.1 $GRADLE_HOME && rm /tmp/gradle.zip

WORKDIR /project
