cmake_minimum_required(VERSION 3.25)
project(vote_machine_api LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)


# Sanitizers setup
option(VOTE_MACHINE_SANITIZERS "Enable address and undefined behavior checks" OFF)
add_library(vote_machine_options INTERFACE)
target_compile_options(vote_machine_options INTERFACE
  -Wall -Wextra -Wpedantic -Werror -Wconversion -Wsign-conversion -Wshadow
)
if(VOTE_MACHINE_SANITIZERS)
  if(NOT CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    message(FATAL_ERROR "Sanitizers require GCC or Clang")
  endif()
  target_compile_options(vote_machine_options INTERFACE
    -fsanitize=address,undefined -fno-omit-frame-pointer
  )
  target_link_options(vote_machine_options INTERFACE -fsanitize=address,undefined)
endif()

# Find libraries
find_package(Drogon CONFIG REQUIRED)
find_package(OpenSSL REQUIRED)
find_library(CMARK_GFM_LIBRARY cmark-gfm REQUIRED)
include(CTest)
if(BUILD_TESTING)
  find_package(GTest CONFIG REQUIRED)
endif()

# Config lib
add_library(vote_machine_config src/config.cpp)
target_include_directories(vote_machine_config PUBLIC src)
target_link_libraries(vote_machine_config PUBLIC vote_machine_options)

# API
add_library(vote_machine_access src/access.cpp)
target_include_directories(vote_machine_access PUBLIC src)
target_link_libraries(vote_machine_access PUBLIC vote_machine_options OpenSSL::Crypto)

add_library(vote_machine_markdown src/markdown.cpp)
target_include_directories(vote_machine_markdown PUBLIC src)
target_link_libraries(vote_machine_markdown PUBLIC vote_machine_access vote_machine_options Drogon::Drogon ${CMARK_GFM_LIBRARY})

add_executable(vote_machine_api src/main.cpp src/rooms.cpp src/http.cpp src/links.cpp src/questions.cpp src/assets.cpp src/voting.cpp src/results.cpp src/live.cpp src/security.cpp)
target_link_libraries(
  vote_machine_api
  PRIVATE vote_machine_config vote_machine_access vote_machine_markdown Drogon::Drogon
)

# Testing
if(BUILD_TESTING)
  add_executable(config_test tests/config_test.cpp)
  target_link_libraries(
    config_test
    PRIVATE vote_machine_config GTest::gtest_main
  )
  add_test(NAME config_test COMMAND config_test)
  add_executable(access_test tests/access_test.cpp)
  target_link_libraries(access_test PRIVATE vote_machine_access GTest::gtest_main)
  add_test(NAME access_test COMMAND access_test)
  add_executable(markdown_test tests/markdown_test.cpp)
  target_link_libraries(markdown_test PRIVATE vote_machine_markdown GTest::gtest_main)
  add_test(NAME markdown_test COMMAND markdown_test)
endif()
